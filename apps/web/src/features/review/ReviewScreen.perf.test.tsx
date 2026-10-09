// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { accountLinkId, txMetaId } from '@/domain/feedIds';

/**
 * 2026-10-09 (user: "when I press Confirm it sometimes takes 3–4 seconds
 * before it continues, or not at all"): the review on a production-sized
 * feed. Its own file because the helper differs from the deck specs — a
 * seeded bank feed of 1 500 rows attached to the demo space, every live
 * query counted — and the numbers are the point: before the fix one bulk
 * confirm re-ran the space join 83 times (every write re-ran every one of
 * the deck's five subscriptions), 7.5 s of query work on fake-indexeddb.
 * The bounds below keep that from coming back; the console lines are the
 * measurement for whoever profiles it next.
 */

const FEED = 'feed_perf';
const ACCOUNT = 'acct_perf';
const ROWS = 1500;
const CATS = ['groceries', 'transport', 'sport', 'telecom', 'hobby', 'clothing'];
/** the full space join — the query every write used to re-run per subscriber */
const JOIN = 'visibleTransactions';

const iso = (daysAgo: number): string => {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** letters only: merchantKey strips digit runs (#450), so numbered names would all collapse into one bulk group */
const alpha = (n: number): string => {
  let s = '';
  let v = n;
  do {
    s = String.fromCodePoint(97 + (v % 26)) + s;
    v = Math.floor(v / 26);
  } while (v > 0);
  return s;
};

/** a production-shaped dataset: one bank feed attached to the demo space, every row wearing the space's overlay;
 *  a fifth of the rows wait in the review — each its own merchant, or (bulk) one shared merchant so the card's
 *  "also apply to similar" fills up */
async function seedLargeFeed(bulkSiblings: boolean): Promise<void> {
  const db = new MunniDB('munni_demo');
  const store = new DexieBackend(db);
  const repo = new Repo(store, new HlcClock('perfseed'), { trackOutbox: false });
  await repo.upsert('space', FEED, FEED, { name: 'Bank feed' });
  await repo.upsert('account', FEED, ACCOUNT, { name: 'Betaalrekening', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 123_456 });
  await repo.upsert('accountLink', DEMO_SPACE_ID, accountLinkId(DEMO_SPACE_ID, FEED), { feedSpaceId: FEED, accountId: ACCOUNT, historyFrom: iso(600) });
  await store.transact(['transaction', 'txMeta', 'outbox'], async () => {
    for (let i = 0; i < ROWS; i++) {
      const review = i % 5 === 0;
      const id = `perf_tx_${i}`;
      const merchant = review ? (bulkSiblings ? 'Shop Together' : `Shop ${alpha(i)}`) : `Merchant ${alpha(i % 60)}`;
      await repo.upsert('transaction', FEED, id, {
        accountId: ACCOUNT,
        date: iso(Math.floor(i / 3)),
        amountCents: -(500 + (i * 37) % 9000),
        currency: 'EUR',
        merchant,
        description: `${merchant.toUpperCase()} PAS 123 NR 00${i}`,
        importRef: `REF-${i}`,
      });
      await repo.upsert('txMeta', DEMO_SPACE_ID, txMetaId(DEMO_SPACE_ID, id), {
        txId: id,
        catId: CATS[i % CATS.length],
        needsReview: review ? 1 : 0,
      });
    }
  });
  db.close();
}

interface QueryStat {
  runs: number;
  ms: number;
}

/** every live query the screen subscribes, counted and timed per executed run (a run the backend's burst
 *  coalescer supersedes never reaches the query and is not counted); plus the local writes */
function instrument() {
  const stats = new Map<string, QueryStat>();
  const marks = { lastQueryEnd: 0, lastWrite: 0, writes: 0 };
  const originalSubscribe = DexieBackend.prototype.subscribe;
  DexieBackend.prototype.subscribe = function <T>(
    this: DexieBackend,
    query: () => Promise<T>,
    onNext: (value: T) => void,
    onError?: (err: unknown) => void,
  ) {
    const label = query.toString().replaceAll(/\s+/g, ' ').slice(0, 90);
    const counted = async (): Promise<T> => {
      const t0 = performance.now();
      try {
        return await query();
      } finally {
        const stat = stats.get(label) ?? { runs: 0, ms: 0 };
        stat.runs += 1;
        stat.ms += performance.now() - t0;
        stats.set(label, stat);
        marks.lastQueryEnd = performance.now();
      }
    };
    // `.call` on the generic method instantiates T as unknown — the callback is the same function either way
    return originalSubscribe.call(this, counted, onNext as (value: unknown) => void, onError);
  };
  const originalUpsert = Repo.prototype.upsert;
  Repo.prototype.upsert = function (this: Repo, ...args: Parameters<Repo['upsert']>) {
    marks.writes += 1;
    marks.lastWrite = performance.now();
    return originalUpsert.apply(this, args);
  } as typeof originalUpsert;
  const restore = () => {
    DexieBackend.prototype.subscribe = originalSubscribe;
    Repo.prototype.upsert = originalUpsert;
  };
  const snapshot = (): Map<string, QueryStat> => new Map([...stats].map(([k, v]) => [k, { ...v }]));
  /** runs and milliseconds per query since `before`, heaviest first */
  const since = (before: Map<string, QueryStat>): { lines: string[]; runsOf: (needle: string) => number; runs: number; ms: number } => {
    const rows: { label: string; runs: number; ms: number }[] = [];
    for (const [label, stat] of stats) {
      const prev = before.get(label) ?? { runs: 0, ms: 0 };
      if (stat.runs === prev.runs) continue;
      rows.push({ label, runs: stat.runs - prev.runs, ms: stat.ms - prev.ms });
    }
    rows.sort((a, b) => b.ms - a.ms);
    return {
      lines: rows.map((r) => `${String(r.runs).padStart(3)} runs ${r.ms.toFixed(0).padStart(6)} ms  ${r.label}`),
      runsOf: (needle) => rows.filter((r) => r.label.includes(needle)).reduce((n, r) => n + r.runs, 0),
      runs: rows.reduce((n, r) => n + r.runs, 0),
      ms: rows.reduce((n, r) => n + r.ms, 0),
    };
  };
  /** resolves once neither a write nor a query run has happened for `quietMs` */
  const settled = async (quietMs: number, maxMs: number): Promise<number> => {
    const start = performance.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      const last = Math.max(marks.lastQueryEnd, marks.lastWrite);
      if (performance.now() - last >= quietMs || performance.now() - start > maxMs) return last;
    }
  };
  return { marks, restore, snapshot, since, settled };
}

describe('ReviewScreen confirm on a large feed (2026-10-09)', () => {
  let probe: ReturnType<typeof instrument> | null = null;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });
  afterEach(() => {
    probe?.restore();
    probe = null;
  });

  /** one confirm, measured from the tap: when the next card is up, when the last write and query landed */
  const measureConfirm = async (bulk: boolean) => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    await seedLargeFeed(bulk);
    cleanup();

    probe = instrument();
    const tMount = performance.now();
    renderApp('/review');
    await screen.findByTestId('review-card', {}, { timeout: 30_000 });
    await screen.findByText(/1 \/ 3[0-9][0-9]/, {}, { timeout: 30_000 });
    const mountMs = performance.now() - tMount;
    // the mount's own queries settle before the confirm is measured
    await probe.settled(400, 20_000);
    const before = probe.snapshot();
    probe.marks.writes = 0;

    const t0 = performance.now();
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    // a bulk over every feed review row lands as ONE update (the burst is coalesced) and the deck moves on to the
    // demo seed's own cards; a single row shows the next card
    if (bulk) await waitFor(() => expect(screen.getByTestId('review-card').textContent).not.toContain('Shop Together'), { timeout: 120_000 });
    else await waitFor(() => expect(screen.getByText(/2 \/ 3[0-9][0-9]/)).toBeTruthy(), { timeout: 60_000 });
    const nextCardMs = performance.now() - t0;
    const settledAt = await probe.settled(400, 60_000);
    const work = probe.since(before);
    console.log(
      [
        `[${bulk ? 'bulk: every review row shares the merchant' : 'single row'}] mount → first card ${mountMs.toFixed(0)} ms; ` +
          `confirm → ${bulk ? 'deck drained' : 'next card'} ${nextCardMs.toFixed(0)} ms; last write/query ${(settledAt - t0).toFixed(0)} ms after the tap`,
        `local writes: ${probe.marks.writes}; query runs: ${work.runs} (${work.ms.toFixed(0)} ms of query work)`,
        ...work.lines,
      ].join('\n'),
    );
    return { work, writes: probe.marks.writes };
  };

  it('a single confirm re-runs the space join once, not once per subscriber and write', async () => {
    const { work, writes } = await measureConfirm(false);
    // the card's own write and the activity line
    expect(writes).toBeLessThanOrEqual(3);
    // 2026-10-09: five subscribers share one live query and a burst of commits runs it once — before: 5 runs
    expect(work.runsOf(JOIN)).toBeLessThanOrEqual(2);
    expect(work.runsOf('buildSpaceMerchantMemory')).toBeLessThanOrEqual(2);
    // the second confirm still advances: the coalescer must not break the live queries' change tracking
    fireEvent.click(screen.getByTestId('review-confirm-btn'));
    await waitFor(() => expect(screen.getByText(/3 \/ 3[0-9][0-9]/)).toBeTruthy(), { timeout: 60_000 });
  }, 180_000);

  it('a bulk confirm over hundreds of siblings is one burst: a handful of query runs, never one per write', async () => {
    const { work, writes } = await measureConfirm(true);
    // every review row rode along as a similar sibling
    expect(writes).toBeGreaterThan(100);
    // before: 83 joins for the first 16 writes alone
    expect(work.runsOf(JOIN)).toBeLessThanOrEqual(4);
    expect(work.runsOf('buildSpaceMerchantMemory')).toBeLessThanOrEqual(4);
  }, 180_000);
});
