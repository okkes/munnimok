import { describe, test } from 'vitest';
import { measure, scrubEvent } from './perf';
import type { TransactionEvent } from './perf';

/**
 * `npm run perf` (vitest bench): the instrumentation's own overhead must
 * stay invisible — a measure() around a hot path may not become the hot
 * path, and the scrub that runs on every sampled transaction must cost
 * less than the fetch it describes. Feature benches join this folder as
 * *.bench.ts with the perf harness (src/test/perfHarness.ts); vitest 5
 * hands `bench` to a regular test as a context fixture.
 */

const id = '0191d9b0-7c2a-7b4e-9a1f-3c5d2e1f0a9b';
const fiftySpans = (): TransactionEvent => ({
  type: 'transaction',
  transaction: 'sync.round',
  request: { url: `https://app.example/#/transactions/${id}` },
  spans: Array.from({ length: 50 }, (_, i) => ({
    span_id: `s${i}`,
    trace_id: 't',
    start_timestamp: i,
    timestamp: i + 1,
    op: 'http.client',
    description: `GET https://api.example/sync/${id}/pull?since=${i}`,
    data: { 'http.url': `https://api.example/sync/${id}/pull?since=${i}`, 'http.query': `?since=${i}` },
  })),
});

describe('perf instrumentation overhead', () => {
  test('measure() around a trivial sync function', async ({ bench }) => {
    await bench('measure.sync', () => {
      measure('bench.sync', () => 1 + 1);
    }).run();
  });

  test('scrubEvent over a 50-span transaction', async ({ bench }) => {
    await bench('scrubEvent.50', () => {
      scrubEvent(fiftySpans());
    }).run();
  });
});
