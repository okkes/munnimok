import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HlcClock } from './hlc';
import { applyOp } from './merge';
import type { Op, SyncEnvelope } from './merge';
import type { PullResult, PushResult, SyncBackend } from './backend';
import { SyncHttpError } from './backend';
import { SyncEngine } from './engine';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import type { AccountRow } from '@/db/types';

/** Minimal in-memory server with the same semantics as Munni.Api. */
class InMemoryServer implements SyncBackend {
  private ops: (Op & { seq: number })[] = [];
  private state = new Map<string, Record<string, unknown> & SyncEnvelope>();
  private seenOpIds = new Set<string>();
  private lastSeq = 0;
  forbiddenSpaces = new Set<string>();
  rejectedSpaces = new Set<string>(); // 400s (a poisoned op) — never 403
  pushCalls: number[] = [];

  async push(spaceId: string, _clientId: string, ops: Op[]): Promise<PushResult> {
    if (this.forbiddenSpaces.has(spaceId)) throw new SyncHttpError(403);
    if (this.rejectedSpaces.has(spaceId)) throw new SyncHttpError(400);
    this.pushCalls.push(ops.length);
    for (const op of ops) {
      if (this.seenOpIds.has(op.opId)) continue;
      this.seenOpIds.add(op.opId);
      const key = `${op.entity}:${op.entityId}`;
      const { row } = applyOp(this.state.get(key) ?? null, op);
      this.state.set(key, row);
      this.ops.push({ ...op, seq: ++this.lastSeq });
    }
    return { lastSeq: this.lastSeq };
  }

  async pull(spaceId: string, since: number): Promise<PullResult> {
    if (this.forbiddenSpaces.has(spaceId)) throw new SyncHttpError(403);
    return { ops: this.ops.filter((o) => o.seq > since && o.spaceId === spaceId), latestSeq: this.lastSeq };
  }

  async listSpaces(): Promise<string[]> {
    return [...new Set(this.ops.map((o) => o.spaceId))].filter((id) => !this.forbiddenSpaces.has(id));
  }
}

let dbCounter = 0;

function device(name: string, wall: () => number, server: InMemoryServer) {
  const db = new MunniDB(`engine_test_${name}_${dbCounter}`);
  const repo = new Repo(new DexieBackend(db), new HlcClock(name, undefined, wall), { trackOutbox: true });
  const engine = new SyncEngine(new DexieBackend(db), repo, server, name);
  return { db, repo, engine };
}

describe('SyncEngine', () => {
  let server: InMemoryServer;
  beforeEach(() => {
    dbCounter++;
    server = new InMemoryServer();
  });
  const dbs: MunniDB[] = [];
  afterEach(async () => {
    while (dbs.length) await dbs.pop()!.delete();
  });

  it('two devices editing offline converge regardless of sync order', async () => {
    let wa = 1_000_000;
    let wb = 2_000_000;
    const a = device('devA', () => ++wa, server);
    const b = device('devB', () => ++wb, server);
    dbs.push(a.db, b.db);

    // both edit the same account while "offline"
    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'From A', balanceCents: 100 });
    await b.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await b.repo.upsert('account', 's1', 'acc1', { name: 'From B', color: '#abc' });

    // A syncs first, then B, then A again to receive B's ops
    await a.engine.syncSpace('s1');
    await b.engine.syncSpace('s1');
    await a.engine.syncSpace('s1');

    const rowA = (await a.db.accounts.get('acc1')) as AccountRow;
    const rowB = (await b.db.accounts.get('acc1')) as AccountRow;
    expect(rowA.fieldVersions).toEqual(rowB.fieldVersions);
    expect(rowA.name).toBe('From B'); // B's clock is ahead
    expect(rowA.balanceCents).toBe(100);
    expect(rowA.color).toBe('#abc');

    // outboxes drained, cursors advanced
    expect(await a.db.outbox.count()).toBe(0);
    expect(await b.db.outbox.count()).toBe(0);
  });

  it('pull cursor prevents re-fetch; own ops are no-ops on replay', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Solo', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.engine.syncSpace('s1');
    const cursor1 = (await a.db.meta.get('syncCursor_s1'))?.value;
    await a.engine.syncSpace('s1'); // nothing new
    const cursor2 = (await a.db.meta.get('syncCursor_s1'))?.value;
    expect(cursor1).toBe(cursor2);
    const space = await a.db.spaces.get('s1');
    expect(space?.name).toBe('Solo');
  });

  it('403 purges the local copy of the space', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Mine', balanceCents: 5 });
    await a.engine.syncSpace('s1');
    expect(await a.db.spaces.get('s1')).toBeTruthy();

    server.forbiddenSpaces.add('s1');
    await a.repo.upsert('account', 's1', 'acc1', { name: 'More' });
    await a.engine.syncSpace('s1');

    expect(await a.db.spaces.get('s1')).toBeUndefined();
    expect(await a.db.accounts.get('acc1')).toBeUndefined();
    expect(await a.db.outbox.count()).toBe(0);
  });

  it('feed data of a space the server no longer grants is purged (left-space ghost accounts)', async () => {
    // feed spaces have no local 'space' row — after leaving the space that
    // shared them, they dropped out of the pull loop and their accounts
    // lingered forever as ghost "shared with me" rows (user report)
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Mine', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    // a shared feed pulled earlier: account row WITHOUT a local space row
    await a.db.accounts.put({ id: 'feed-acc', spaceId: 'feed-1', name: 'Their ING', deleted: 0, fieldVersions: {} } as unknown as AccountRow);
    await a.db.meta.put({ key: 'syncCursor_feed-1', value: 7 });

    await a.engine.syncAll(); // server lists only s1 — access to feed-1 is gone

    expect(await a.db.accounts.get('feed-acc')).toBeUndefined();
    expect(await a.db.meta.get('syncCursor_feed-1')).toBeUndefined();
    // the personal space itself is untouched
    expect((await a.db.spaces.get('s1'))?.name).toBe('Mine');
  });

  it('big outboxes push in chunks; a poisoned space never starves the others', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    // 650 queued ops → three chunked pushes (300/300/50), all drained
    await a.repo.upsert('space', 's1', 's1', { name: 'Big', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    for (let i = 0; i < 649; i++) await a.repo.upsert('receipt', 's1', `r${i}`, { merchant: 'AH', totalCents: i });
    await a.engine.syncAll();
    expect(server.pushCalls).toEqual([300, 300, 50]);
    expect(await a.db.outbox.count()).toBe(0);

    // s-poison rejects its push (a bad op) — s2 must still sync fine
    await a.repo.upsert('space', 's-poison', 's-poison', { name: 'Bad', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('space', 's2', 's2', { name: 'Good', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    server.rejectedSpaces.add('s-poison');
    await a.engine.syncAll(); // reports 'error' but must not abort the loop
    const s2Outbox = (await a.db.outbox.toArray()).filter((o) => o.spaceId === 's2');
    expect(s2Outbox).toHaveLength(0); // the healthy space drained
    const poisonOutbox = (await a.db.outbox.toArray()).filter((o) => o.spaceId === 's-poison');
    expect(poisonOutbox.length).toBeGreaterThan(0); // kept for retry, not dropped
  });

  it('fresh device discovers and pulls spaces it has never seen', async () => {
    let wa = 1_000_000;
    const a = device('devA', () => ++wa, server);
    dbs.push(a.db);
    await a.repo.upsert('space', 's1', 's1', { name: 'Existing', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await a.repo.upsert('account', 's1', 'acc1', { name: 'Mine', balanceCents: 42 });
    await a.engine.syncAll();

    // brand-new device, empty database
    let wb = 2_000_000;
    const b = device('devB', () => ++wb, server);
    dbs.push(b.db);
    await b.engine.syncAll();

    expect((await b.db.spaces.get('s1'))?.name).toBe('Existing');
    expect((await b.db.accounts.get('acc1'))?.balanceCents).toBe(42);
  });

  it('interrupted push retries safely (idempotent op ids)', async () => {
    let w = 1_000_000;
    const a = device('devA', () => ++w, server);
    dbs.push(a.db);

    await a.repo.upsert('space', 's1', 's1', { name: 'Solo', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });

    // simulate: push reached the server but the response was lost
    const outbox = await a.db.outbox.toArray();
    await server.push('s1', 'devA', outbox);
    // engine retries the full outbox — server dedupes, then pull applies own ops as no-ops
    await a.engine.syncSpace('s1');

    const pull = await server.pull('s1', 0);
    expect(pull.ops).toHaveLength(outbox.length); // no duplicates server-side
    expect(await a.db.outbox.count()).toBe(0);
  });
});
