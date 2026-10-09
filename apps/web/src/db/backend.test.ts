// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { MunniDB } from './schema';
import { DexieBackend, LIVE_QUERY_QUIET_MS } from './backend';
import { Repo } from './repo';
import { HlcClock } from '@/sync/hlc';

/**
 * 2026-10-09 (user: Confirm stalled 3–4 s): the Dexie backend's live
 * queries coalesce a burst of commits into one re-run — and keep tracking
 * changes after it (the wait must not cost Dexie's observation zone).
 */
describe('DexieBackend.subscribe', () => {
  const dbs: MunniDB[] = [];
  afterEach(async () => {
    for (const db of dbs.splice(0)) await db.delete();
  });

  const fresh = () => {
    const db = new MunniDB(`munni_backend_${Math.random().toString(36).slice(2)}`);
    dbs.push(db);
    const store = new DexieBackend(db);
    const repo = new Repo(store, new HlcClock('be'), { trackOutbox: false });
    return { store, repo };
  };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const row = (i: number) => ({ accountId: 'a', date: '2026-10-09', amountCents: -100 * i, currency: 'EUR', merchant: `M${i}`, needsReview: 1 as const });

  it('runs at once the first time, then once per burst of commits — with the final state', async () => {
    const { store, repo } = fresh();
    const seen: number[] = [];
    const off = store.subscribe(
      async () => (await store.bySpace('transaction', 's')).length,
      (n) => seen.push(n),
    );
    await sleep(LIVE_QUERY_QUIET_MS * 2);
    expect(seen).toEqual([0]); // the first run is not delayed

    // a burst: twelve commits back to back, as the review's bulk writes land —
    // a leading run (the first commit found the query idle; Dexie may abort it)
    // and one trailing run after the burst, never one per write
    for (let i = 1; i <= 12; i++) await repo.upsert('transaction', 's', `t${i}`, row(i));
    await sleep(LIVE_QUERY_QUIET_MS * 4);
    expect(seen.at(-1)).toBe(12);
    expect(seen.length).toBeLessThanOrEqual(3);
    off();
  });

  it('keeps tracking after a coalesced run: spaced writes each re-run once', async () => {
    const { store, repo } = fresh();
    const seen: number[] = [];
    const off = store.subscribe(
      async () => (await store.bySpace('transaction', 's')).length,
      (n) => seen.push(n),
    );
    await sleep(LIVE_QUERY_QUIET_MS * 2);
    // each write is given until the count ARRIVES (a loaded machine stretches a run past the
    // quiet window, which merged two writes into one re-run and failed the shape below), then a
    // quiet beat — a duplicate re-run would still show up as an extra entry
    const arrived = async (count: number) => {
      const until = Date.now() + 3000;
      while (seen.at(-1) !== count && Date.now() < until) await sleep(10);
      await sleep(LIVE_QUERY_QUIET_MS * 2);
    };
    for (let i = 1; i <= 3; i++) {
      await repo.upsert('transaction', 's', `t${i}`, row(i));
      await arrived(i);
    }
    expect(seen).toEqual([0, 1, 2, 3]);
    // a write to another table the query never read changes nothing
    await repo.upsert('space', 's', 's', { name: 'S' });
    await sleep(LIVE_QUERY_QUIET_MS * 4);
    expect(seen).toEqual([0, 1, 2, 3]);
    off();
  });

  it('a declared burst holds every re-run until it ends, however slowly its writes come', async () => {
    const { store, repo } = fresh();
    const seen: number[] = [];
    const off = store.subscribe(
      async () => (await store.bySpace('transaction', 's')).length,
      (n) => seen.push(n),
    );
    await sleep(LIVE_QUERY_QUIET_MS * 2);
    // the review's confirm: writes spaced wider than the quiet window (a render in between) are still one burst
    await store.burst(async () => {
      for (let i = 1; i <= 4; i++) {
        await repo.upsert('transaction', 's', `t${i}`, row(i));
        await sleep(LIVE_QUERY_QUIET_MS * 2);
      }
    });
    await sleep(LIVE_QUERY_QUIET_MS * 4);
    expect(seen).toEqual([0, 4]); // one update, with everything
    off();
  });

  it('a subscription closed while it waits never emits again', async () => {
    const { store, repo } = fresh();
    const seen: number[] = [];
    const off = store.subscribe(
      async () => (await store.bySpace('transaction', 's')).length,
      (n) => seen.push(n),
    );
    await sleep(LIVE_QUERY_QUIET_MS * 2);
    await repo.upsert('transaction', 's', 't1', row(1));
    off(); // inside the quiet window
    await sleep(LIVE_QUERY_QUIET_MS * 4);
    expect(seen).toEqual([0]);
  });
});
