// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { MunniDB, identityDbName } from '@/db/schema';
import { HlcClock } from './hlc';
import type { PullResult, PushResult, SpaceHead, SyncBackend } from './backend';
import type { Op } from './merge';
import { backgroundPull, flushOutbox, readSwSession } from './swSync';
import type { SwSession } from './swSync';

const SESSION: SwSession = { apiUrl: 'http://api', identityKey: 'user_sw-test', bearer: 't', expiresAt: Date.now() + 60_000 };

class FakeBackend implements SyncBackend {
  ops: Record<string, Op[]> = {};
  pushed: { spaceId: string; ops: Op[] }[] = [];
  spaces: string[] = [];
  async push(spaceId: string, _clientId: string, ops: Op[]): Promise<PushResult> {
    this.pushed.push({ spaceId, ops });
    return { lastSeq: ops.length };
  }
  /** pages like the server (Take(1000)); Infinity = everything at once */
  pageSize = Number.POSITIVE_INFINITY;
  async pull(spaceId: string, since: number): Promise<PullResult> {
    const all = this.ops[spaceId] ?? [];
    const ops = all.slice(since, since + this.pageSize);
    return { ops, latestSeq: all.length, nextSince: since + ops.length };
  }
  async listSpaces(): Promise<string[]> {
    return this.spaces;
  }
  async heads(): Promise<SpaceHead[]> {
    return this.spaces.map((spaceId) => ({ spaceId, latestSeq: (this.ops[spaceId] ?? []).length }));
  }
}

const spaceOp = (spaceId: string, name: string): Op => ({
  opId: `op-${spaceId}-${name}`,
  spaceId,
  entity: 'space',
  entityId: spaceId,
  fields: { name, kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 },
  hlc: '000000100-0000-srv',
});

const categoryOp = (spaceId: string, i: number): Op => ({
  opId: `op-${spaceId}-cat-${i}`,
  spaceId,
  entity: 'category',
  entityId: `${spaceId}-cat-${i}`,
  fields: { name: `Category ${i}` },
  hlc: '000000100-0000-srv',
});

describe('service-worker background sync', () => {
  afterEach(async () => {
    await new MunniDB(identityDbName(SESSION.identityKey)).delete();
  });

  it('readSwSession rejects missing or expired sessions', async () => {
    expect(await readSwSession()).toBeNull(); // nothing mirrored
    expect(
      // expired bearer — the worker cannot refresh, so it must skip
      await (async () => {
        const s: SwSession = { ...SESSION, expiresAt: Date.now() - 1 };
        return s.expiresAt! <= Date.now() ? null : s;
      })(),
    ).toBeNull();
  });

  it('backgroundPull applies ops into the identity db and advances cursors', async () => {
    const backend = new FakeBackend();
    backend.spaces = ['sp1', 'sp2'];
    backend.ops.sp1 = [spaceOp('sp1', 'Home')];
    backend.ops.sp2 = [spaceOp('sp2', 'Work')];

    const applied = await backgroundPull(undefined, { backend, session: SESSION });
    expect(applied).toBe(2);

    const db = new MunniDB(identityDbName(SESSION.identityKey));
    expect((await db.spaces.get('sp1'))?.name).toBe('Home');
    expect((await db.spaces.get('sp2'))?.name).toBe('Work');
    expect((await db.meta.get('syncCursor_sp1'))?.value).toBe(1);

    // second run: cursors make it a no-op
    expect(await backgroundPull(undefined, { backend, session: SESSION })).toBe(0);
    db.close();
  });

  it('a push-woken pull of a space with more than one page drains it — the cursor never jumps past ops it did not apply', async () => {
    // before: one page applied, the cursor stamped at the head, the other 15 ops skipped for good
    const backend = new FakeBackend();
    backend.pageSize = 10;
    backend.ops.sp1 = [spaceOp('sp1', 'Home'), ...Array.from({ length: 24 }, (_, i) => categoryOp('sp1', i))];

    expect(await backgroundPull('sp1', { backend, session: SESSION })).toBe(25);

    const db = new MunniDB(identityDbName(SESSION.identityKey));
    expect((await db.categories.toArray()).filter((c) => c.spaceId === 'sp1')).toHaveLength(24);
    expect((await db.meta.get('syncCursor_sp1'))?.value).toBe(25);
    db.close();
  });

  it('a wake that runs out of time stops at the last page it applied, and the next pull goes on from there', async () => {
    let clock = 0;
    const backend = new FakeBackend();
    backend.pageSize = 10;
    backend.spaces = ['sp1', 'sp2'];
    backend.ops.sp1 = [spaceOp('sp1', 'Home'), ...Array.from({ length: 24 }, (_, i) => categoryOp('sp1', i))];
    backend.ops.sp2 = [spaceOp('sp2', 'Work')];
    // every page costs a second
    const pull = backend.pull.bind(backend);
    backend.pull = async (spaceId, since) => {
      clock += 1_000;
      return pull(spaceId, since);
    };

    // a one-second budget: the first page lands, the cursor stops with it, the next space waits
    expect(await backgroundPull(undefined, { backend, session: SESSION, now: () => clock, budgetMs: 1_000 })).toBe(10);
    const db = new MunniDB(identityDbName(SESSION.identityKey));
    expect((await db.meta.get('syncCursor_sp1'))?.value).toBe(10);
    expect(await db.meta.get('syncCursor_sp2')).toBeUndefined();

    // the next wake resumes from the page it stopped at: nothing skipped, nothing twice
    expect(await backgroundPull(undefined, { backend, session: SESSION, now: () => clock })).toBe(16);
    expect((await db.categories.toArray()).filter((c) => c.spaceId === 'sp1')).toHaveLength(24);
    expect((await db.meta.get('syncCursor_sp1'))?.value).toBe(25);
    expect((await db.spaces.get('sp2'))?.name).toBe('Work');
    db.close();
  });

  it('backgroundPull scoped to the pushed space only touches that space', async () => {
    const backend = new FakeBackend();
    backend.ops.sp1 = [spaceOp('sp1', 'Home')];
    backend.ops.sp2 = [spaceOp('sp2', 'Work')];
    await backgroundPull('sp1', { backend, session: SESSION });

    const db = new MunniDB(identityDbName(SESSION.identityKey));
    expect(await db.spaces.get('sp1')).toBeTruthy();
    expect(await db.spaces.get('sp2')).toBeUndefined();
    db.close();
  });

  it('a missing session is a quiet no-op, never a throw', async () => {
    expect(await backgroundPull(undefined, { session: null })).toBe(0);
    expect(await flushOutbox({ session: null })).toBe(0);
  });

  it('flushOutbox pushes queued ops in HLC order and clears them', async () => {
    // seed an outbox exactly like the app's repo does
    const db = new MunniDB(identityDbName(SESSION.identityKey));
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const repo = new Repo(new DexieBackend(db), new HlcClock('dev'), { trackOutbox: true });
    await repo.upsert('space', 'sp1', 'sp1', { name: 'Offline edit', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('space', 'sp1', 'sp1', { name: 'Offline edit 2' });
    db.close();

    const backend = new FakeBackend();
    const pushed = await flushOutbox({ backend, session: SESSION });
    expect(pushed).toBe(2);
    expect(backend.pushed[0].spaceId).toBe('sp1');
    const hlcs = backend.pushed[0].ops.map((o) => o.hlc);
    expect([...hlcs].sort((a, b) => a.localeCompare(b))).toEqual(hlcs);

    // drained: a second flush pushes nothing
    expect(await flushOutbox({ backend, session: SESSION })).toBe(0);
  });

  it('#505: leaves a space this identity only reads to the app, which undoes and tells', async () => {
    const db = new MunniDB(identityDbName(SESSION.identityKey));
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const repo = new Repo(new DexieBackend(db), new HlcClock('dev'), { trackOutbox: true });
    await repo.upsert('space', 'sp-mine', 'sp-mine', { name: 'Mine', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('event', 'sp-read', 'ev1', { name: 'Queued before the role was known' });
    await db.meta.put({ key: 'spaceRoles', value: { 'sp-mine': 'owner', 'sp-read': 'reader' } });
    db.close();

    const backend = new FakeBackend();
    await flushOutbox({ backend, session: SESSION });

    expect(backend.pushed.map((p) => p.spaceId)).toEqual(['sp-mine']);
    const reopened = new MunniDB(identityDbName(SESSION.identityKey));
    expect((await reopened.outbox.toArray()).map((o) => o.spaceId)).toEqual(['sp-read']);
    reopened.close();
  });
});
