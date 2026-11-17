// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import initSqlJs from 'sql.js';
import type { Database } from 'sql.js';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import type { Op } from '@/sync/merge';
import { DexieBackend, LIVE_QUERY_QUIET_MS } from './backend';
import type { StorageBackend } from './backend';
import { visibleTransactions, writeTxTransform } from './joined';
import { Repo } from './repo';
import { MunniDB } from './schema';
import { NATIVE_CHARS, READ_PAGE, SqlStorageBackend, initSqlSchema } from './sqlBackend';
import type { SqlExecutor } from './sqlBackend';

// parity: every scenario runs against BOTH backends and asserts the same results;
// on device the executor is SQLCipher, here sql.js

let SQL: Awaited<ReturnType<typeof initSqlJs>>;
beforeAll(async () => {
  SQL = await initSqlJs();
});

function sqlJsExecutor(db: Database): SqlExecutor {
  return {
    async run(sql, params = []) {
      db.run(sql, params);
    },
    async batch(statements) {
      for (const statement of statements) db.run(statement.sql, statement.params);
    },
    async query(sql, params = []) {
      const stmt = db.prepare(sql);
      stmt.bind(params);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },
    async transaction(fn) {
      db.run('BEGIN');
      try {
        await fn();
        db.run('COMMIT');
      } catch (err) {
        db.run('ROLLBACK');
        throw err;
      }
    },
    async close() {
      db.close();
    },
    async destroy() {
      db.close();
    },
  };
}

interface Ctx {
  name: string;
  store: StorageBackend;
  repo: Repo;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

let dbSeq = 0;
async function bothBackends(): Promise<Ctx[]> {
  const dexie = new DexieBackend(new MunniDB(`munni_parity_${++dbSeq}`));
  const sqlDb = new SQL.Database();
  const executor = sqlJsExecutor(sqlDb);
  await initSqlSchema(executor);
  const sql = new SqlStorageBackend(executor);
  cleanups.push(() => void dexie.destroy(), () => sql.close());
  return [
    { name: 'dexie', store: dexie, repo: new Repo(dexie, new HlcClock('parity-d'), { trackOutbox: true }) },
    { name: 'sql', store: sql, repo: new Repo(sql, new HlcClock('parity-s'), { trackOutbox: true }) },
  ];
}

const SPACE = 's1';

describe('SqlStorageBackend parity with DexieBackend', () => {
  it('repo upsert/merge/tombstone reads back identically', async () => {
    for (const { name, store, repo } of await bothBackends()) {
      await repo.upsert('account', SPACE, 'a1', { name: 'Checking', type: 'checking', balanceCents: 1000 });
      await repo.upsert('account', SPACE, 'a1', { balanceCents: 2500 });
      await repo.upsert('account', SPACE, 'a2', { name: 'Savings', type: 'savings', balanceCents: 9000 });
      await repo.remove('account', SPACE, 'a2');

      const a1 = await store.get('account', 'a1');
      expect(a1, name).toMatchObject({ name: 'Checking', balanceCents: 2500, deleted: 0 });
      const a2 = await store.get('account', 'a2');
      expect(a2?.deleted, name).toBe(1);
      expect((await store.bySpace('account', SPACE)).length, name).toBe(2);
      expect(await store.countBySpace('account', SPACE), name).toBe(2);
      const outbox = await store.outboxBySpace(SPACE);
      expect(outbox.length, name).toBe(4);
      expect([...outbox].sort((x, y) => x.hlc.localeCompare(y.hlc)), name).toEqual(outbox);
    }
  });

  it('#296: txSeen rows round-trip on BOTH backends — the native list forgot the entity and user login crashed', async () => {
    for (const { name, store, repo } of await bothBackends()) {
      await repo.upsert('txSeen', SPACE, 'seen-1', { forSpaceId: 's-x', txId: 't1', labeledAt: 123 });
      const rows = await store.bySpace('txSeen', SPACE);
      expect(rows, name).toHaveLength(1);
      expect(rows[0], name).toMatchObject({ forSpaceId: 's-x', txId: 't1', labeledAt: 123, deleted: 0 });
    }
  });

  it('the joined read model works unchanged on both backends', async () => {
    for (const { name, store, repo } of await bothBackends()) {
      await repo.upsert('transaction', 'feed1', 'raw1', {
        accountId: 'acc1',
        date: '2026-01-15',
        amountCents: -2999,
        currency: 'EUR',
        merchant: 'Bol.com',
        needsReview: 1,
      });
      await repo.upsert('accountLink', SPACE, 'link1', { feedSpaceId: 'feed1', accountId: 'acc1' });
      const [joined] = await visibleTransactions(store, SPACE);
      expect(joined, name).toMatchObject({ id: 'raw1', feedSpaceId: 'feed1', needsReview: 1 });

      await writeTxTransform(repo, joined, { catId: 'groceries', needsReview: 0 });
      const [after] = await visibleTransactions(store, SPACE);
      expect(after, name).toMatchObject({ catId: 'groceries', needsReview: 0 });
      // the raw row itself is untouched (transformation lives in the overlay)
      expect((await store.get('transaction', 'raw1'))?.catId, name).toBeUndefined();
    }
  });

  it('meta, outbox drain and purge behave identically', async () => {
    for (const { name, store, repo } of await bothBackends()) {
      await store.metaPut('cursor', 42);
      expect((await store.metaGet('cursor'))?.value, name).toBe(42);
      await store.metaPut('cursor', { deep: ['ok', 1] });
      expect((await store.metaGet('cursor'))?.value, name).toEqual({ deep: ['ok', 1] });

      await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
      await repo.upsert('category', SPACE, 'c1', { name: 'Padel', icon: 'tennis', color: '#123', txType: 'expense', sortOrder: 1, builtin: 0 });
      const ops = await store.outboxAll();
      await store.outboxDelete(ops.map((o) => o.opId));
      expect((await store.outboxAll()).length, name).toBe(0);

      await store.transact(['category', 'space', 'meta'], async () => {
        await store.deleteBySpace('category', SPACE);
        await store.deleteRow('space', SPACE);
        await store.metaDelete('cursor');
      });
      expect(await store.get('space', SPACE), name).toBeUndefined();
      expect((await store.bySpace('category', SPACE)).length, name).toBe(0);
      expect(await store.metaGet('cursor'), name).toBeUndefined();
    }
  });

  it('a space hands out its waiting changes in the order they were made, whatever order they were stored in', async () => {
    const op = (opId: string, hlc: string, spaceId = SPACE) => ({ opId, spaceId, entity: 'category' as const, entityId: opId, fields: { name: opId }, hlc });
    for (const { name, store } of await bothBackends()) {
      await store.outboxAdd(op('late', '2026-11-17T10:00:02.000Z-0000-phone'));
      await store.outboxAdd(op('elsewhere', '2026-11-17T10:00:00.500Z-0000-phone', 'other'));
      await store.outboxAdd(op('early', '2026-11-17T10:00:01.000Z-0000-phone'));

      expect((await store.outboxBySpace(SPACE)).map((o) => o.opId), name).toEqual(['early', 'late']);
      // one entry per waiting op: a count and the spaces with something to send, without what the ops carry
      expect((await store.outboxSpaceIds()).sort(), name).toEqual(['other', SPACE, SPACE].sort());
    }
  });

  it('device-only stores round-trip', async () => {
    for (const { name, store } of await bothBackends()) {
      await store.connectorConnPut({ id: 'c1', provider: 'ah', bundle: 'sb_v1.x', state: 'active', refreshedAt: '2026-01-01' });
      expect((await store.connectorConnGet('c1'))?.state, name).toBe('active');
      expect((await store.connectorConnAll()).length, name).toBe(1);
      await store.connectorConnDelete('c1');
      expect(await store.connectorConnGet('c1'), name).toBeUndefined();

      await store.quoteCachePutAll([{ key: 'yahoo:ASML', price: 700, currency: 'EUR', at: '2026-01-01' }]);
      await store.quoteCachePutAll([{ key: 'yahoo:ASML', price: 710, currency: 'EUR', at: '2026-01-02' }]);
      const quotes = await store.quoteCacheAll();
      expect(quotes, name).toHaveLength(1);
      expect(quotes[0].price, name).toBe(710);
    }
  });

  it('subscribe emits the initial result and every relevant change', async () => {
    for (const { name, store, repo } of await bothBackends()) {
      const seen: number[] = [];
      let resolveSettled: (() => void) | null = null;
      const unsubscribe = store.subscribe(
        async () => (await store.bySpace('budget', SPACE)).filter((b) => b.deleted === 0).length,
        (n) => {
          seen.push(n);
          resolveSettled?.();
        },
      );
      const nextEmit = () =>
        new Promise<void>((resolve) => {
          resolveSettled = resolve;
        });

      let settled = nextEmit();
      await settled;
      settled = nextEmit();
      await repo.upsert('budget', SPACE, 'b1', { name: 'Food', amountCents: 100, every: 'month', anchor: '2026-01-01', catIds: [], active: 1 });
      await settled;
      expect(seen[0], name).toBe(0);
      expect(seen.at(-1), name).toBe(1);

      unsubscribe();
      const count = seen.length;
      await repo.upsert('budget', SPACE, 'b2', { name: 'Fun', amountCents: 200, every: 'month', anchor: '2026-01-01', catIds: [], active: 1 });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(seen.length, name).toBe(count);
    }
  });

  it('a failed transaction leaves nothing behind (atomicity)', async () => {
    for (const { name, store } of await bothBackends()) {
      await expect(
        store.transact(['event', 'outbox'], async () => {
          await store.put('event', { id: 'e1', spaceId: SPACE, name: 'Trip' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await store.get('event', 'e1'), name).toBeUndefined();
    }
  });
});

// #554: a write wakes only the queries that read what it touched, and a burst reaches each once
// (native re-ran every query on every write: 26 s on the matcher's first pass)
describe('SqlStorageBackend live queries', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const sqlStore = async () => {
    const { store, repo } = (await bothBackends())[1];
    return { store, repo };
  };
  const row = (i: number) => ({ accountId: 'a', date: '2026-10-09', amountCents: -100 * i, currency: 'EUR', merchant: `M${i}`, needsReview: 1 as const });
  // a loaded machine stretches every step: wait for the value, not a fixed time
  const untilSeen = async (seen: unknown[], value: unknown) => {
    const until = Date.now() + 3000;
    while (seen.at(-1) !== value && Date.now() < until) await sleep(10);
  };

  it('a write wakes only the queries that read what it touched — a table, a meta key, the outbox', async () => {
    const { store, repo } = await sqlStore();
    const rows: number[] = [];
    const flags: unknown[] = [];
    const pending: number[] = [];
    const offs = [
      store.subscribe(async () => (await store.bySpace('transaction', 's')).length, (n) => rows.push(n)),
      store.subscribe(async () => (await store.metaGet('flag'))?.value, (v) => flags.push(v)),
      store.subscribe(async () => (await store.outboxAll()).length, (n) => pending.push(n)),
    ];
    await repo.upsert('transaction', 's', 't1', row(1));
    await store.metaPut('flag', 'on');
    await untilSeen(rows, 1);
    await untilSeen(flags, 'on');
    await sleep(LIVE_QUERY_QUIET_MS * 3);
    const before = { rows: rows.length, flags: flags.length, pending: pending.length };

    await store.metaPut('lastSyncAt', 1); // nobody reads it — a sync round's stamp
    await store.metaPut('flag', 'off');
    await untilSeen(flags, 'off');
    await sleep(LIVE_QUERY_QUIET_MS * 3);
    expect(rows).toHaveLength(before.rows);
    expect(flags).toHaveLength(before.flags + 1);

    await store.outboxDelete((await store.outboxAll()).map((o) => o.opId));
    await untilSeen(pending, 0);
    await sleep(LIVE_QUERY_QUIET_MS * 3);
    expect(rows).toHaveLength(before.rows);
    expect(flags).toHaveLength(before.flags + 1);
    for (const off of offs) off();
  });

  it('a burst of writes reaches each query once, with the final state', async () => {
    const { store, repo } = await sqlStore();
    const seen: number[] = [];
    const off = store.subscribe(async () => (await store.bySpace('transaction', 's')).length, (n) => seen.push(n));
    await untilSeen(seen, 0);
    await sleep(LIVE_QUERY_QUIET_MS * 2);
    // the review's confirm: writes spaced wider than the quiet window are still one burst
    await store.burst!(async () => {
      for (let i = 1; i <= 4; i++) {
        await repo.upsert('transaction', 's', `t${i}`, row(i));
        await sleep(LIVE_QUERY_QUIET_MS * 2);
      }
    });
    await untilSeen(seen, 4);
    await sleep(LIVE_QUERY_QUIET_MS * 3);
    expect(seen).toEqual([0, 4]);

    // writes back to back without a declared burst: a leading run and a trailing one, never one per write
    for (let i = 5; i <= 16; i++) await repo.upsert('transaction', 's', `t${i}`, row(i));
    await untilSeen(seen, 16);
    await sleep(LIVE_QUERY_QUIET_MS * 3);
    expect(seen.at(-1)).toBe(16);
    expect(seen.length).toBeLessThanOrEqual(5);
    off();
  });

  it('a transaction that rolls back wakes nobody; a closed subscription never emits again', async () => {
    const { store, repo } = await sqlStore();
    const seen: number[] = [];
    const off = store.subscribe(async () => (await store.bySpace('event', SPACE)).length, (n) => seen.push(n));
    await untilSeen(seen, 0);
    await sleep(LIVE_QUERY_QUIET_MS * 2);
    await expect(
      store.transact(['event'], async () => {
        await store.put('event', { id: 'e1', spaceId: SPACE, name: 'Trip' });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await sleep(LIVE_QUERY_QUIET_MS * 3);
    expect(seen).toEqual([0]);
    await store.burst!(async () => {
      await repo.upsert('event', SPACE, 'e2', { name: 'Fair' });
      off(); // closed while its re-run waits for the burst to end
    });
    await sleep(LIVE_QUERY_QUIET_MS * 4);
    expect(seen).toEqual([0]);
  });
});

describe('transaction serialization (SQLCipher regression)', () => {
  it('concurrent un-awaited transactions serialize instead of nesting', async () => {
    // a manual tx + its balance delta fired without awaiting: BEGIN inside BEGIN on SQLCipher
    const backend = (await bothBackends())[1].store;
    const writes = Array.from({ length: 6 }, (_, i) =>
      backend.transact(['account'], async () => {
        await backend.put('account', { id: `acc-${i}`, spaceId: 's1', name: `A${i}`, deleted: 0, fieldVersions: {} } as never);
      }),
    );
    await Promise.all(writes);
    const rows = await backend.bySpace('account', 's1');
    expect(rows).toHaveLength(6);
  });

  it('a rejecting transaction does not wedge the queue', async () => {
    const backend = (await bothBackends())[1].store;
    await expect(
      backend.transact(['account'], async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await backend.transact(['account'], async () => {
      await backend.put('account', { id: 'after', spaceId: 's1', name: 'After', deleted: 0, fieldVersions: {} } as never);
    });
    expect((await backend.bySpace('account', 's1')).map((r) => r.id)).toContain('after');
  });
});

describe('what a pulled page costs the native store (#594)', () => {
  function counted(executor: SqlExecutor): { executor: SqlExecutor; calls: () => number } {
    let n = 0;
    const count = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => (...args: A) => {
      n += 1;
      return fn(...args);
    };
    return {
      calls: () => n,
      executor: {
        ...executor,
        run: count(executor.run),
        batch: count(executor.batch),
        query: count(executor.query),
        transaction: count(executor.transaction),
      },
    };
  }

  function page(): Op[] {
    const server = new HlcClock('server', undefined, () => 1_800_000_000_000);
    return Array.from({ length: 1000 }, (_, i) => {
      const row = i % 600;
      return row % 2 === 0
        ? { opId: `op-${i}`, spaceId: SPACE, entity: 'transaction', entityId: `t-${row}`, fields: { accountId: 'a1', date: '2026-07-01', amountCents: -100 - i, currency: 'EUR', merchant: `Shop ${i}`, needsReview: 0 }, hlc: server.now() }
        : { opId: `op-${i}`, spaceId: SPACE, entity: 'txMeta', entityId: `m-${row}`, fields: { txId: `t-${row - 1}`, note: `note ${i}` }, hlc: server.now() };
    });
  }

  it('a thousand changes reach the store in a handful of native calls, not two each', async () => {
    const base = sqlJsExecutor(new SQL.Database());
    await initSqlSchema(base);
    const { executor, calls } = counted(base);
    const store = new SqlStorageBackend(executor);
    cleanups.push(() => store.close());
    const repo = new Repo(store, new HlcClock('phone'), { trackOutbox: false });

    await repo.applyRemoteOps(page());

    // two per change kept a new phone on "Fetching your spaces — 0 of 24" for minutes
    expect(calls()).toBeLessThanOrEqual(12);
    expect(await store.countBySpace('transaction', SPACE)).toBe(300);
    expect(await store.countBySpace('txMeta', SPACE)).toBe(300);
    expect((await store.get('transaction', 't-0'))?.merchant).toBe('Shop 600');
    expect((await store.get('txMeta', 'm-599') as { note?: string } | undefined)?.note).toBe('note 599');
  });
});

describe('a whole table never crosses to the web layer in one piece (#594)', () => {
  const rowsFor = (count: number, space = SPACE) =>
    Array.from({ length: count }, (_, i) => ({ id: `t-${String(i).padStart(5, '0')}`, spaceId: space, merchant: `Shop ${i}`, fieldVersions: {}, deleted: 0 as const }));

  function watched(executor: SqlExecutor, between?: () => Promise<void>): { executor: SqlExecutor; reads: number[] } {
    const reads: number[] = [];
    let pending = between;
    return {
      reads,
      executor: {
        ...executor,
        async query(sql, params) {
          const rows = await executor.query(sql, params);
          if (!sql.includes('FROM e_transaction')) return rows;
          reads.push(rows.length);
          const run = pending;
          pending = undefined;
          if (run) await run();
          return rows;
        },
      },
    };
  }

  it('a table and a space are read a page at a time, and nothing is lost or doubled on the way', async () => {
    const base = sqlJsExecutor(new SQL.Database());
    await initSqlSchema(base);
    const { executor, reads } = watched(base);
    const store = new SqlStorageBackend(executor);
    cleanups.push(() => store.close());
    const total = READ_PAGE * 2 + 500;
    await store.putMany('transaction', rowsFor(total));
    await store.putMany('transaction', rowsFor(3, 'other').map((row) => ({ ...row, id: `o-${row.id}` })));

    const all = await store.allRows('transaction');
    expect(all).toHaveLength(total + 3);
    expect(new Set(all.map((row) => row.id)).size).toBe(total + 3);
    expect(Math.max(...reads)).toBe(READ_PAGE);

    reads.length = 0;
    const space = await store.bySpace('transaction', SPACE);
    expect(space).toHaveLength(total);
    expect(space.every((row) => row.spaceId === SPACE)).toBe(true);
    expect(reads).toEqual([READ_PAGE, READ_PAGE, 500]);
  });

  it('a row rewritten while the pages are read comes out once, as it stands', async () => {
    const base = sqlJsExecutor(new SQL.Database());
    await initSqlSchema(base);
    const plain = new SqlStorageBackend(base);
    cleanups.push(() => plain.close());
    await plain.putMany('transaction', rowsFor(READ_PAGE + 10));
    // the first page is out; a sync page rewrites one of its rows before the next is read
    const { executor } = watched(base, () => plain.put('transaction', { ...rowsFor(1)[0], merchant: 'Rewritten' }));
    const store = new SqlStorageBackend(executor);
    cleanups.push(() => store.close());

    const all = await store.allRows('transaction');

    expect(all).toHaveLength(READ_PAGE + 10);
    expect(all.filter((row) => row.id === 't-00000').map((row) => row.merchant)).toEqual(['Rewritten']);
  });
});

describe('no message to or from native code outgrows the phone (#594)', () => {
  const FEED = 'store-feed';
  const invoice = (chars: number, fill = 'A') => `data:application/pdf;base64,${fill.repeat(chars)}`;
  const file = (i: number, chars: number, fill?: string) => ({
    id: `r-${String(i).padStart(4, '0')}`,
    spaceId: FEED,
    ownerId: `rcpt:amazon-nl:conn:${i}`,
    dataUrl: invoice(chars, fill),
    fieldVersions: {},
    deleted: 0 as const,
  });
  const textOf = (values: readonly unknown[]) => values.reduce<number>((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);
  // a failed toEqual would print both invoices: megabytes of one letter
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  /** the text each read and each write carries across, and a hook that runs once after the first read that matches */
  function weighed(executor: SqlExecutor, after?: { sql: string; run: () => Promise<void> }) {
    const reads: number[] = [];
    const writes: number[] = [];
    let pending = after;
    return {
      reads,
      writes,
      executor: {
        ...executor,
        async query(sql, params) {
          const rows = await executor.query(sql, params);
          reads.push(rows.reduce((n, row) => n + textOf(Object.values(row)), 0));
          if (pending && sql.includes(pending.sql)) {
            const { run } = pending;
            pending = undefined;
            await run();
          }
          return rows;
        },
        async run(sql, params = []) {
          writes.push(textOf(params));
          return executor.run(sql, params);
        },
        async batch(statements) {
          writes.push(statements.reduce((n, s) => n + textOf(s.params), 0));
          return executor.batch(statements);
        },
      } satisfies SqlExecutor,
    };
  }

  async function phone(after?: { sql: string; run: () => Promise<void> }) {
    const base = sqlJsExecutor(new SQL.Database());
    await initSqlSchema(base);
    const plain = new SqlStorageBackend(base);
    const { executor, reads, writes } = weighed(base, after);
    const store = new SqlStorageBackend(executor);
    cleanups.push(() => store.close());
    return { plain, store, reads, writes };
  }

  it('the invoices of a feed are read in pieces the phone can build', async () => {
    const { store, reads } = await phone();
    // 150 invoices of 100,000 characters: 15 million in the feed, where 75 million in one read ended the app
    await store.putMany('receiptFile', Array.from({ length: 150 }, (_, i) => file(i, 100_000)));
    reads.length = 0;

    const rows = await store.bySpace('receiptFile', FEED);

    expect(rows).toHaveLength(150);
    expect(rows.every((row) => row.dataUrl.length === invoice(100_000).length)).toBe(true);
    expect(Math.max(...reads)).toBeLessThanOrEqual(NATIVE_CHARS);
  });

  it('one row larger than a whole message comes back whole, a slice at a time', async () => {
    const { store, reads } = await phone();
    const scan = file(1, NATIVE_CHARS * 2 + 12_345);
    await store.put('receiptFile', scan);
    await store.put('receiptFile', file(2, 10));
    await store.metaPut('big', { text: 'm'.repeat(NATIVE_CHARS + 77) });
    reads.length = 0;

    const all = await store.allRows('receiptFile');
    const one = await store.get('receiptFile', scan.id);
    const some = await store.getMany('receiptFile', ['r-0002', scan.id]);
    const meta = await store.metaGet('big');

    expect(all.map((row) => row.id)).toEqual(['r-0001', 'r-0002']);
    expect(same(all[0], scan)).toBe(true);
    expect(same(one, scan)).toBe(true);
    expect(some.map((row) => row.id).sort()).toEqual(['r-0001', 'r-0002']);
    expect((meta?.value as { text: string }).text).toHaveLength(NATIVE_CHARS + 77);
    expect(Math.max(...reads)).toBeLessThanOrEqual(NATIVE_CHARS);
  });

  it('a large row rewritten after its page was read comes out once, as it stands', async () => {
    const rewritten = { ...file(0, 50_000, 'B'), ownerId: 'rewritten' };
    const { plain, store } = await phone({ sql: 'LIMIT', run: () => plain.put('receiptFile', rewritten) });
    await plain.putMany('receiptFile', [file(0, 50_000), file(1, 50_000)]);

    const rows = await store.bySpace('receiptFile', FEED);

    expect(rows.map((row) => row.id).sort()).toEqual(['r-0000', 'r-0001']);
    expect(same(rows.find((row) => row.id === 'r-0000'), rewritten)).toBe(true);
  });

  it('a row that took the place of another between two slices is read again, never glued from two rows', async () => {
    const first = file(0, NATIVE_CHARS + 500, 'A');
    const second = file(0, NATIVE_CHARS + 900, 'B');
    // a row deleted and written again gets the place the old one had, when that was the last
    const again = async () => {
      await plain.deleteRow('receiptFile', first.id);
      await plain.put('receiptFile', second);
    };
    const { plain, store } = await phone({ sql: 'substr', run: again });
    await plain.put('receiptFile', first);

    expect(same(await store.get('receiptFile', first.id), second)).toBe(true);
  });

  it('a page of invoices is written in pieces the phone can take', async () => {
    const { store, writes } = await phone();

    await store.putMany('receiptFile', Array.from({ length: 150 }, (_, i) => file(i, 100_000)));

    expect(Math.max(...writes)).toBeLessThanOrEqual(NATIVE_CHARS);
    expect(await store.countBySpace('receiptFile', FEED)).toBe(150);
  });

  it('counting what waits to be sent reads none of it (#630): a photo is one op', async () => {
    const { store, reads } = await phone();
    for (let i = 0; i < 3; i++) {
      await store.outboxAdd({ opId: `op-${i}`, spaceId: FEED, entity: 'receiptFile', entityId: `f-${i}`, fields: { dataUrl: invoice(500_000) }, hlc: `00000010${i}-0000-phone` });
    }
    reads.length = 0;

    expect(await store.outboxSpaceIds()).toEqual([FEED, FEED, FEED]);
    expect(Math.max(...reads)).toBeLessThan(100);
  });

  it('small rows still travel a page at a time: one read for a table that fits', async () => {
    const { store, reads } = await phone();
    await store.putMany('receiptFile', Array.from({ length: 300 }, (_, i) => file(i, 10)));
    reads.length = 0;

    expect(await store.bySpace('receiptFile', FEED)).toHaveLength(300);
    expect(reads).toHaveLength(1);
  });
});
