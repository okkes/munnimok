// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PERF_DEFAULT_SIZE, PERF_FEED_ID, PERF_SPACE_ID, buildPerfStore, timeIt } from './perfHarness';
import type { PerfStore } from './perfHarness';

/** the harness itself: the dataset it promises, the envelopes real code
 *  expects, and a timing a test can assert on */
describe('perf harness', () => {
  let data: PerfStore | null = null;
  afterEach(() => {
    data?.close();
    data = null;
  });

  it('builds the full dataset with proper envelopes, the same rows every time', async () => {
    data = await buildPerfStore();
    expect(data.size).toEqual(PERF_DEFAULT_SIZE);
    expect(await data.db.transactions.count()).toBe(1500);
    expect(await data.db.receipts.count()).toBe(300);
    expect(await data.db.recurrings.count()).toBe(40);
    const txs = await data.store.allRows('transaction');
    expect(txs.every((t) => t.deleted === 0 && t.spaceId === PERF_SPACE_ID && typeof t.fieldVersions.amountCents === 'string')).toBe(true);
    expect(txs.filter((t) => t.needsReview === 1).length).toBeGreaterThanOrEqual(60);
    expect(txs.some((t) => t.recurringId)).toBe(true);
    const receipts = await data.store.allRows('receipt');
    expect(receipts.every((r) => r.spaceId === PERF_FEED_ID && r.items && r.items.length > 0)).toBe(true);
    // deterministic: a second build yields the same first row
    const first = txs.find((t) => t.id === 'perf_tx_1');
    data.close();
    data = await buildPerfStore();
    expect((await data.store.allRows('transaction')).find((t) => t.id === 'perf_tx_1')).toEqual(first);
  });

  it('builds a smaller dataset on request and times a function', async () => {
    data = await buildPerfStore({ transactions: 50, receipts: 5, recurring: 2 });
    expect(await data.db.transactions.count()).toBe(50);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const store = data.store;
    const { ms, result } = await timeIt('harness.smoke', async () => (await store.allRows('transaction')).length, 10_000);
    expect(result).toBe(50);
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(info).toHaveBeenCalledWith(expect.stringMatching(/^\[perf\] harness\.smoke: \d+ ms \(budget 10000 ms\)$/));
    info.mockRestore();
  });
});
