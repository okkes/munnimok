import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { SpaceReadOnlyError } from '@/sync/spaceAccess';
import { MunniDB } from './schema';
import { Repo } from './repo';
import { DexieBackend } from './backend';
import type { AccountRow } from './types';

let dbCounter = 0;

function makeRepo(deviceId: string, db: MunniDB, wall: () => number, trackOutbox = true) {
  return new Repo(new DexieBackend(db), new HlcClock(deviceId, undefined, wall), { trackOutbox });
}

describe('Repo', () => {
  let db: MunniDB;
  let wallMs: number;

  beforeEach(() => {
    db = new MunniDB(`test_${++dbCounter}`);
    wallMs = 1_000_000;
  });

  afterEach(async () => {
    await db.delete();
  });

  it('upsert creates a row and queues an outbox op', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs);
    await repo.upsert('account', 's1', 'a1', {
      name: 'Checking',
      type: 'checking',
      source: 'manual',
      currency: 'EUR',
      balanceCents: 12345,
    });

    const row = (await db.accounts.get('a1'))!;
    expect(row).toMatchObject({ id: 'a1', spaceId: 's1', name: 'Checking', balanceCents: 12345, deleted: 0 });
    expect(row.fieldVersions.name).toBeTruthy();

    const ops = await db.outbox.toArray();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ entity: 'account', entityId: 'a1', spaceId: 's1' });
  });

  it('partial update only bumps versions of the changed fields', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs);
    await repo.upsert('account', 's1', 'a1', { name: 'Checking', balanceCents: 100 });
    const before = (await db.accounts.get('a1'))!;
    await repo.upsert('account', 's1', 'a1', { balanceCents: 200 });
    const after = (await db.accounts.get('a1'))!;

    expect(after.balanceCents).toBe(200);
    expect(after.fieldVersions.name).toBe(before.fieldVersions.name);
    expect(after.fieldVersions.balanceCents).not.toBe(before.fieldVersions.balanceCents);
  });

  it('remove tombstones instead of deleting', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs);
    await repo.upsert('category', 's1', 'c1', { name: 'Food', icon: 'food', color: '#fff', txType: 'expense', sortOrder: 1, builtin: 0 });
    await repo.remove('category', 's1', 'c1');
    const row = (await db.categories.get('c1'))!;
    expect(row.deleted).toBe(1);
  });

  it('trackOutbox=false (demo/offline) writes rows but never queues ops', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs, false);
    await repo.upsert('account', 's1', 'a1', { name: 'Cash' });
    expect(await db.accounts.count()).toBe(1);
    expect(await db.outbox.count()).toBe(0);
  });

  it('upsertMany lands many rows in one transaction, each merged and queued like an upsert', async () => {
    const store = new DexieBackend(db);
    let transactions = 0;
    const transact = store.transact.bind(store);
    store.transact = (tables, fn) => {
      transactions += 1;
      return transact(tables, fn);
    };
    let writes = 0;
    const repo = new Repo(store, new HlcClock('devA', undefined, () => ++wallMs), { trackOutbox: true, onWrite: () => (writes += 1) });
    await repo.upsert('account', 's1', 'a1', { name: 'Checking', balanceCents: 100 });
    transactions = 0;
    writes = 0;

    await repo.upsertMany('account', [
      { spaceId: 's1', entityId: 'a1', fields: { balanceCents: 200 } },
      { spaceId: 's1', entityId: 'a2', fields: { name: 'Savings', balanceCents: 900 } },
      { spaceId: 's2', entityId: 'a3', fields: { name: 'Shared' } },
    ]);
    expect(transactions).toBe(1);
    expect(writes).toBe(1);
    expect(await db.accounts.get('a1')).toMatchObject({ name: 'Checking', balanceCents: 200 }); // merged, not replaced
    expect(await db.accounts.get('a3')).toMatchObject({ spaceId: 's2', name: 'Shared', deleted: 0 });
    const ops = await db.outbox.toArray();
    expect(ops.map((o) => o.entityId)).toEqual(['a1', 'a1', 'a2', 'a3']);
    expect(new Set(ops.map((o) => o.hlc)).size).toBe(4); // every op its own stamp

    // one malformed row refuses the set
    await expect(
      repo.upsertMany('transaction', [
        { spaceId: 's1', entityId: 't1', fields: { accountId: 'a', date: '2026-07-01', amountCents: -100, currency: 'EUR', merchant: 'X', needsReview: 0 } },
        { spaceId: 's1', entityId: 't2', fields: { accountId: 'a', date: '2026-07-01', amountCents: 10.5, currency: 'EUR', merchant: 'X', needsReview: 0 } },
      ]),
    ).rejects.toMatchObject({ name: 'InvariantViolation' });
    expect(await db.transactions.count()).toBe(0);
    expect(await db.outbox.count()).toBe(4);
    await repo.upsertMany('account', []); // nothing to write: no transaction
    expect(transactions).toBe(2);
  });

  it('applyRemoteOps merges remote edits; local newer fields win', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs);
    await repo.upsert('account', 's1', 'a1', { name: 'Mine', balanceCents: 100 });

    // remote edit stamped in the past: name loses, color (new field) applies
    const remoteHlc = new HlcClock('devB', undefined, () => 500_000);
    await repo.applyRemoteOps([
      {
        opId: 'op-remote-1',
        spaceId: 's1',
        entity: 'account',
        entityId: 'a1',
        fields: { name: 'Theirs', color: '#123456' },
        hlc: remoteHlc.now(),
      },
    ]);

    const row = (await db.accounts.get('a1')) as AccountRow;
    expect(row.name).toBe('Mine');
    expect(row.color).toBe('#123456');
  });

  it('two repos (devices) converge through exchanged ops regardless of order', async () => {
    const dbA = new MunniDB(`test_conv_a_${dbCounter}`);
    const dbB = new MunniDB(`test_conv_b_${dbCounter}`);
    let wa = 1_000_000;
    let wb = 2_000_000; // device B's clock runs 1000s ahead
    const repoA = makeRepo('devA', dbA, () => ++wa);
    const repoB = makeRepo('devB', dbB, () => ++wb);

    // both devices edit the same account "offline"
    await repoA.upsert('account', 's1', 'a1', { name: 'From A', balanceCents: 100 });
    await repoB.upsert('account', 's1', 'a1', { name: 'From B', color: '#abc' });

    // exchange outboxes in opposite orders (simulates who-syncs-first)
    const opsA = await dbA.outbox.toArray();
    const opsB = await dbB.outbox.toArray();
    await repoA.applyRemoteOps(opsB);
    await repoB.applyRemoteOps(opsA);

    const rowA = (await dbA.accounts.get('a1')) as AccountRow;
    const rowB = (await dbB.accounts.get('a1')) as AccountRow;
    expect(rowA.name).toBe(rowB.name);
    expect(rowA.balanceCents).toBe(rowB.balanceCents);
    expect(rowA.color).toBe(rowB.color);
    expect(rowA.fieldVersions).toEqual(rowB.fieldVersions);
    // B's wall clock was ahead, so B's name wins on both devices
    expect(rowA.name).toBe('From B');
    expect(rowA.balanceCents).toBe(100); // only A ever set it — survives

    await dbA.delete();
    await dbB.delete();
  });

  it('model invariants block a malformed local write, whole and clean', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs);
    // a screen's validation leaked: fractional cents
    await expect(
      repo.upsert('transaction', 's1', 't1', {
        accountId: 'a',
        date: '2026-07-01',
        amountCents: 10.5,
        currency: 'EUR',
        merchant: 'X',
        needsReview: 0,
      }),
    ).rejects.toMatchObject({ name: 'InvariantViolation' });
    // nothing landed: no row, no outbox op
    expect(await db.transactions.get('t1')).toBeUndefined();
    expect(await db.outbox.toArray()).toHaveLength(0);

    // malformed shapes are caught too (split without a category)
    await expect(
      repo.upsert('transaction', 's1', 't2', {
        accountId: 'a',
        date: '2026-07-01',
        amountCents: -1_000,
        currency: 'EUR',
        merchant: 'X',
        needsReview: 0,
        splits: [{ catId: '', amountCents: 500 }],
      }),
    ).rejects.toMatchObject({ name: 'InvariantViolation' });

    // a part's category spread must sum to the part (v2.1)
    await expect(
      repo.upsert('transaction', 's1', 't3', {
        accountId: 'a',
        date: '2026-07-01',
        amountCents: -1_000,
        currency: 'EUR',
        merchant: 'X',
        needsReview: 0,
        splits: [
          { catId: 'g', amountCents: 1_000, cats: [{ catId: 'g', amountCents: 700 }, { catId: 'h', amountCents: 200 }] },
        ],
      }),
    ).rejects.toMatchObject({ name: 'InvariantViolation' });

    // #211: the ROW's category spread must sum to the gross amount
    await expect(
      repo.upsert('transaction', 's1', 't4', {
        accountId: 'a',
        date: '2026-07-01',
        amountCents: -1_000,
        currency: 'EUR',
        merchant: 'X',
        needsReview: 0,
        cats: [{ catId: 'g', amountCents: 700 }, { catId: 'h', amountCents: 200 }],
      }),
    ).rejects.toMatchObject({ name: 'InvariantViolation' });
    // ...and a sound spread lands (a lone settled entry is legal too)
    await repo.upsert('transaction', 's1', 't5', {
      accountId: 'a',
      date: '2026-07-01',
      amountCents: -1_000,
      currency: 'EUR',
      merchant: 'X',
      needsReview: 0,
      cats: [{ catId: 'g', amountCents: 700 }, { catId: 'h', amountCents: 300 }],
    });
    expect((await db.transactions.get('t5'))?.cats).toHaveLength(2);
  });

  it('remote ops are never refused — convergence beats validation', async () => {
    const repo = makeRepo('devA', db, () => ++wallMs);
    // another device (or an older build) owns this contradictory row
    await repo.applyRemoteOps([
      {
        opId: 'op-remote',
        spaceId: 's1',
        entity: 'transaction',
        entityId: 'remote1',
        fields: { accountId: 'a', date: '2026-07-01', amountCents: 1_000, currency: 'EUR', merchant: 'X', txType: 'expense', needsReview: 0 },
        hlc: '2026-07-01T00:00:00.000Z-0000-devB',
      },
    ]);
    // the row landed as sent — every device converges on the same rows
    expect((await db.transactions.get('remote1'))?.merchant).toBe('X');
  });

  describe('#505: a space this identity only reads', () => {
    const readerRepo = () =>
      new Repo(new DexieBackend(db), new HlcClock('devR', undefined, () => ++wallMs), {
        trackOutbox: true,
        readOnly: (spaceId) => spaceId === 'shared',
      });

    it('refuses every write there before anything changes', async () => {
      const repo = readerRepo();
      await expect(repo.upsert('event', 'shared', 'ev1', { name: 'Trip' })).rejects.toBeInstanceOf(SpaceReadOnlyError);
      await expect(repo.remove('event', 'shared', 'ev1')).rejects.toBeInstanceOf(SpaceReadOnlyError);
      expect(await db.events.get('ev1')).toBeUndefined();
      expect(await db.outbox.count()).toBe(0);
      expect(repo.canWrite('shared')).toBe(false);
    });

    it('refuses a batch that touches it as a whole', async () => {
      const repo = readerRepo();
      await expect(
        repo.upsertMany('event', [
          { spaceId: 'mine', entityId: 'ev-mine', fields: { name: 'Mine' } },
          { spaceId: 'shared', entityId: 'ev-shared', fields: { name: 'Theirs' } },
        ]),
      ).rejects.toBeInstanceOf(SpaceReadOnlyError);
      expect(await db.events.count()).toBe(0);
    });

    it('leaves every other space as writable as ever', async () => {
      const repo = readerRepo();
      await repo.upsert('event', 'mine', 'ev1', { name: 'Trip' });
      expect((await db.events.get('ev1'))?.name).toBe('Trip');
      expect(await db.outbox.count()).toBe(1);
    });

    it('the upkeep view skips its rows and writes the rest', async () => {
      const upkeep = readerRepo().upkeep();
      await upkeep.upsert('event', 'shared', 'ev-shared', { name: 'Theirs' });
      await upkeep.upsertMany('event', [
        { spaceId: 'mine', entityId: 'ev-mine', fields: { name: 'Mine' } },
        { spaceId: 'shared', entityId: 'ev-shared2', fields: { name: 'Theirs' } },
      ]);
      expect((await db.events.toArray()).map((e) => e.id)).toEqual(['ev-mine']);
      expect(upkeep.upkeep()).toBe(upkeep);
    });

    it('pulled ops still land there — the server’s rows are the reader’s view', async () => {
      await readerRepo().applyRemoteOps([
        { opId: 'op1', spaceId: 'shared', entity: 'event', entityId: 'ev1', fields: { name: 'Theirs' }, hlc: '000000100-0000-owner' },
      ]);
      expect((await db.events.get('ev1'))?.name).toBe('Theirs');
    });
  });
});
