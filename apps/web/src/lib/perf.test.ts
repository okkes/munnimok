import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react';
import type { INPMetricWithAttribution } from 'web-vitals/attribution';
import type { TransactionEvent } from './perf';
import {
  installWebVitals,
  isIdleSyncRound,
  mark,
  measure,
  opFor,
  perfBudget,
  scrubEvent,
  scrubUrl,
  setSlowLogSink,
  slowLog,
  summarizeInp,
  tagSpacePeriod,
  transactionFilter,
} from './perf';

vi.mock('@sentry/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sentry/react')>()),
  setMeasurement: vi.fn(),
  setTag: vi.fn(),
}));
vi.mock('./report', () => ({ reportWarning: vi.fn() }));
import { reportWarning } from './report';

const sink = vi.fn();

beforeEach(() => {
  sink.mockClear();
  setSlowLogSink(sink);
});
afterEach(() => {
  setSlowLogSink(null);
  vi.clearAllMocks();
});

/** a transaction event the way the SDK hands it to beforeSendTransaction */
const transaction = (over: Partial<TransactionEvent> = {}): TransactionEvent => ({
  type: 'transaction',
  transaction: 'sync.round',
  start_timestamp: 1000,
  timestamp: 1000.5,
  contexts: { trace: { trace_id: 't', span_id: 's', data: { 'sync.ops_pushed': 0, 'sync.rows_pulled': 0 } } },
  ...over,
});

describe('measure', () => {
  it('returns a sync result and names the op by the area', () => {
    const out = measure('review.confirm', (span) => {
      expect(span).toBeTruthy();
      return 42;
    });
    expect(out).toBe(42);
    expect(opFor('review.confirm')).toBe('munni.review');
    expect(opFor('sync')).toBe('munni.sync');
  });

  it('passes an async result through and rejections untouched', async () => {
    await expect(measure('sync.round', async () => 'done')).resolves.toBe('done');
    await expect(measure('sync.round', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(() => measure('sync.round', () => { throw new Error('sync boom'); })).toThrow('sync boom');
  });

  it('warns the dev sink when a budgeted span overruns, and only then', async () => {
    const slow = vi.spyOn(performance, 'now');
    slow.mockReturnValueOnce(0).mockReturnValueOnce(perfBudget['planning.build'] + 1);
    measure('planning.build', () => undefined);
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0][0]).toMatch(/planning\.build took 151 ms \(budget 150 ms\)/);
    slow.mockRestore();

    sink.mockClear();
    measure('planning.build', () => undefined); // well under budget
    measure('no.budget', () => undefined); // nothing to overrun
    expect(sink).not.toHaveBeenCalled();
  });
});

describe('slowLog and mark', () => {
  it('slowLog answers whether the budget was overrun', () => {
    expect(slowLog('review.confirm', 299)).toBe(false);
    expect(slowLog('review.confirm', 301)).toBe(true);
    expect(slowLog('custom', 10_000)).toBe(false); // no budget, no finding
    expect(slowLog('custom', 10, 5)).toBe(true); // an explicit budget
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink.mock.calls[0][1]).toEqual({ name: 'review.confirm', ms: 301, budget: 300 });
  });

  it('mark records a measurement and the budget check', () => {
    mark('receipts.match', 800);
    expect(Sentry.setMeasurement).toHaveBeenCalledWith('receipts.match', 800, 'millisecond');
    expect(sink).toHaveBeenCalledTimes(1);
  });

  it('tags the period type, never an id', () => {
    tagSpacePeriod('week');
    tagSpacePeriod(undefined);
    expect(Sentry.setTag).toHaveBeenNthCalledWith(1, 'space.period', 'week');
    expect(Sentry.setTag).toHaveBeenNthCalledWith(2, 'space.period', 'none');
  });
});

describe('scrubbing (routes, never rows)', () => {
  it('drops queries, fragments and ids from a URL, keeping the route pattern', () => {
    expect(scrubUrl('https://api.example/sync/0191d9b0-7c2a-7b4e-9a1f-3c5d2e1f0a9b/pull?since=12')).toBe('https://api.example/sync/:id/pull');
    expect(scrubUrl('http://localhost:8180/health')).toBe('http://localhost:8180/health');
    expect(scrubUrl('https://app.example/#/transactions/0191d9b0-7c2a-7b4e-9a1f-3c5d2e1f0a9b?x=1')).toBe('https://app.example/#/transactions/:id');
    expect(scrubUrl('/#/invite?token=abcdef')).toBe('/#/invite');
    expect(scrubUrl('/connections/receipts/rcpt-ah-9f8e7d6c5b4a3210')).toBe('/connections/receipts/:id');
    expect(scrubUrl('/sync/events')).toBe('/sync/events');
    expect(scrubUrl('/assets/index-DQmR3b1x9a2f8c7e.js')).toBe('/assets/index-DQmR3b1x9a2f8c7e.js'); // a file keeps its name
    expect(scrubUrl('/periods/2026-10')).toBe('/periods/2026-10');
    expect(scrubUrl('/ops/123456')).toBe('/ops/:id');
  });

  it('scrubs the event url, the trace data, breadcrumbs and every span', () => {
    const id = '0191d9b0-7c2a-7b4e-9a1f-3c5d2e1f0a9b';
    const event = transaction({
      transaction: '/transactions/$txId',
      request: { url: `https://app.example/#/transactions/${id}`, query_string: 'a=b' },
      contexts: {
        trace: {
          trace_id: 't',
          span_id: 's',
          data: { 'url.full': `https://app.example/transactions/${id}`, 'url.path.params.txId': id, 'params.txId': id, 'sentry.source': 'route' },
        },
      },
      breadcrumbs: [
        { category: 'fetch', data: { method: 'GET', url: `https://api.example/receipts/${id}?full=1`, status_code: 200 } },
        { category: 'navigation', data: { from: `/#/transactions/${id}`, to: '/#/review' } },
      ],
      spans: [
        {
          span_id: 'a',
          trace_id: 't',
          start_timestamp: 1,
          timestamp: 2,
          op: 'http.client',
          description: `GET https://api.example/sync/${id}/pull?since=3`,
          data: { 'http.url': `https://api.example/sync/${id}/pull?since=3`, 'http.query': '?since=3', 'url.full': `https://api.example/sync/${id}/pull?since=3`, 'http.method': 'GET' },
        },
      ],
    });
    const out = scrubEvent(event);
    expect(out.request).toEqual({ url: 'https://app.example/#/transactions/:id' });
    expect(out.contexts?.trace?.data).toEqual({ 'url.full': 'https://app.example/transactions/:id', 'sentry.source': 'route' });
    expect(out.breadcrumbs?.[0].data).toEqual({ method: 'GET', url: 'https://api.example/receipts/:id', status_code: 200 });
    expect(out.breadcrumbs?.[1].data).toEqual({ from: '/#/transactions/:id', to: '/#/review' });
    expect(out.spans?.[0].description).toBe('GET https://api.example/sync/:id/pull');
    expect(out.spans?.[0].data).toEqual({ 'http.url': 'https://api.example/sync/:id/pull', 'url.full': 'https://api.example/sync/:id/pull', 'http.method': 'GET' });
  });

  it('leaves an event without urls alone', () => {
    const event = { message: 'hello' };
    expect(scrubEvent(event)).toEqual({ message: 'hello' });
  });
});

describe('the idle sync round', () => {
  it('is dropped when nothing moved and it stayed under budget', () => {
    expect(isIdleSyncRound(transaction())).toBe(true);
    expect(transactionFilter(transaction())).toBeNull();
  });

  it('ships when something moved, when it was slow, or when it is another transaction', () => {
    const pushed = transaction({ contexts: { trace: { trace_id: 't', span_id: 's', data: { 'sync.ops_pushed': 3, 'sync.rows_pulled': 0 } } } });
    expect(isIdleSyncRound(pushed)).toBe(false);
    const slow = transaction({ timestamp: 1000 + (perfBudget['sync.round'] + 1) / 1000 });
    expect(isIdleSyncRound(slow)).toBe(false);
    const navigation = transaction({ transaction: '/review' });
    expect(isIdleSyncRound(navigation)).toBe(false);
    expect(transactionFilter(navigation)).toBe(navigation);
    // no trace data at all: nothing moved by definition, under budget
    expect(isIdleSyncRound(transaction({ contexts: {} }))).toBe(true);
  });
});

describe('web vitals: the interaction the person felt', () => {
  const metric = (over: Partial<INPMetricWithAttribution> = {}): INPMetricWithAttribution =>
    ({
      name: 'INP',
      value: 812.4,
      rating: 'poor',
      delta: 812.4,
      id: 'v1',
      navigationType: 'navigate',
      entries: [],
      attribution: {
        interactionTarget: 'button[data-testid="review-confirm"]',
        interactionTime: 10,
        interactionType: 'pointer',
        nextPaintTime: 822,
        processedEventEntries: [],
        inputDelay: 20.6,
        processingDuration: 700.2,
        presentationDelay: 91.6,
        loadState: 'complete',
        longAnimationFrameEntries: [],
        longestScript: {
          entry: { invoker: 'BUTTON.onclick', sourceURL: 'https://app.example/assets/index.js', sourceFunctionName: 'confirmCard', duration: 650 } as unknown as PerformanceScriptTiming,
          subpart: 'processing-duration',
          intersectingDuration: 650.4,
        },
      },
      ...over,
    }) as INPMetricWithAttribution;

  it('summarizes the attribution without any content', () => {
    expect(summarizeInp(metric())).toEqual({
      value: 812,
      rating: 'poor',
      target: 'button[data-testid="review-confirm"]',
      type: 'pointer',
      inputDelay: 21,
      processingDuration: 700,
      presentationDelay: 92,
      loadState: 'complete',
      longestScript: { invoker: 'BUTTON.onclick', url: 'https://app.example/assets/index.js', fn: 'confirmCard', subpart: 'processing-duration', ms: 650 },
    });
    const bare = metric();
    delete bare.attribution.longestScript;
    expect(summarizeInp(bare).longestScript).toBeUndefined();
  });

  it('reports a poor interaction once per page life, never a good one', () => {
    const report = vi.fn();
    let callback: ((m: INPMetricWithAttribution) => void) | undefined;
    installWebVitals(report, (cb) => { callback = cb; });
    callback?.(metric({ rating: 'good', value: 80 }));
    expect(report).not.toHaveBeenCalled();
    callback?.(metric());
    callback?.(metric({ value: 1200 }));
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].value).toBe(812);
  });

  it('files the default report as a GlitchTip warning named after the element', () => {
    let callback: ((m: INPMetricWithAttribution) => void) | undefined;
    installWebVitals(undefined, (cb) => { callback = cb; });
    callback?.(metric());
    expect(reportWarning).toHaveBeenCalledWith('web-vitals', 'INP poor: button[data-testid="review-confirm"]', expect.objectContaining({ value: 812, processingDuration: 700 }));
  });
});
