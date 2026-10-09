import * as Sentry from '@sentry/react';
import type { BrowserOptions, Event as SentryEvent, Span } from '@sentry/react';
import { onINP } from 'web-vitals/attribution';
import type { INPMetricWithAttribution } from 'web-vitals/attribution';
import { reportWarning } from './report';

// the SDK keeps these two off its public type surface; the hook signature carries them
export type TransactionEvent = Parameters<NonNullable<BrowserOptions['beforeSendTransaction']>>[0];
type SpanJSON = NonNullable<TransactionEvent['spans']>[number];

/**
 * Performance instrumentation (user 2026-10-09: "3–4 seconds on Confirm,
 * sometimes nothing"): the next slow path must be visible with numbers,
 * in production and on the developer's machine. One protocol, one place —
 * spans ride the Sentry SDK into GlitchTip's Performance view beside the
 * errors (docs/observability.md); in development the same spans warn in
 * the console when they overrun their budget. Every helper is a no-op
 * without a Sentry client (no DSN; the demo/offline gates in main.tsx),
 * and nothing here carries contents: names, counts and durations only.
 */

/** what a hot path may take, in ms, before it is a finding: the dev
 *  console warns and the span is tagged `munni.over_budget` */
export const perfBudget: Readonly<Record<string, number>> = Object.freeze({
  /** store open + the demo seed + the first queries, to the first screen */
  'app.boot': 1500,
  /** the review deck's Confirm: the tap to the next card */
  'review.confirm': 300,
  /** one push/pull round over every space */
  'sync.round': 2000,
  /** the planning model for one period */
  'planning.build': 150,
  /** matching fetched receipts against transactions */
  'receipts.match': 500,
});

export type PerfAttributes = Record<string, string | number | boolean>;

export interface MeasureOptions {
  /** nest under this span instead of the scope's current one — async
   *  code that interleaves with the UI's own spans names its parent;
   *  `null` = a root of its own (a transaction) even while another span
   *  is active, for work that outlives the span it was started from */
  parent?: Span | null;
}

/** `review.confirm` → `munni.review`: the op GlitchTip groups transactions by */
export const opFor = (name: string): string => `munni.${name.split('.')[0]}`;

type SlowSink = (message: string, detail: { name: string; ms: number; budget: number }) => void;

// the dev server's console; silent in production builds and under the
// test runner (a slow CI box is not a finding) — tests install their own
let slowSink: SlowSink | null = import.meta.env.DEV && !import.meta.env.VITEST ? (message) => console.warn(message) : null;

/** where budget overruns go (tests); null silences them */
export function setSlowLogSink(sink: SlowSink | null): void {
  slowSink = sink;
}

/** the dev-time catch: true when `ms` overran the budget (and the sink was told) */
export function slowLog(name: string, ms: number, budget: number | undefined = perfBudget[name]): boolean {
  if (budget === undefined || ms <= budget) return false;
  slowSink?.(`[perf] ${name} took ${Math.round(ms)} ms (budget ${budget} ms)`, { name, ms, budget });
  return true;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function';

function settle(span: Span, name: string, started: number): void {
  const ms = performance.now() - started;
  const budget = perfBudget[name];
  span.setAttribute('munni.ms', Math.round(ms));
  if (budget !== undefined) {
    span.setAttribute('munni.budget_ms', budget);
    span.setAttribute('munni.over_budget', ms > budget);
  }
  slowLog(name, ms, budget);
}

/**
 * Time `fn` as a span named `name` (op `munni.<area>`): a root span is a
 * transaction in GlitchTip, a nested one a row in its parent's waterfall.
 * Sync or async — the result (or the rejection) passes through untouched.
 */
export function measure<T>(name: string, fn: (span: Span) => T, attributes?: PerfAttributes, options: MeasureOptions = {}): T {
  return Sentry.startSpan({ name, op: opFor(name), attributes, parentSpan: options.parent }, (span) => {
    const started = performance.now();
    let result: T;
    try {
      result = fn(span);
    } catch (err) {
      settle(span, name, started);
      throw err;
    }
    if (!isThenable(result)) {
      settle(span, name, started);
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        settle(span, name, started);
        return value;
      },
      (err: unknown) => {
        settle(span, name, started);
        throw err;
      },
    ) as T;
  });
}

/** a cheap custom number on the active transaction (a phase inside a
 *  span, a count that explains a duration) + the same dev-time budget check */
export function mark(name: string, ms: number): void {
  Sentry.setMeasurement(name, ms, 'millisecond');
  Sentry.getActiveSpan()?.setAttribute(`munni.${name}_ms`, Math.round(ms));
  slowLog(name, ms);
}

/** the active space's period type on every event and transaction (never
 *  an id): the period math scales with it (user 2026-10-09) */
export function tagSpacePeriod(periodType: string | undefined): void {
  Sentry.setTag('space.period', periodType ?? 'none');
}

/* ── what leaves: routes, never rows ──────────────────────────────────── */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** an id in a path: a uuid, a run of digits (a cursor, a seq) or a long
 *  token carrying a digit (a hash, a party's own id) — file names keep their dot */
const isIdSegment = (segment: string): boolean =>
  UUID.test(segment) || /^\d{4,}$/.test(segment) || (segment.length >= 16 && /\d/.test(segment) && !segment.includes('.'));

const scrubSegments = (path: string): string => path.split('/').map((s) => (isIdSegment(s) ? ':id' : s)).join('/');

/**
 * Ids, queries and fragments out of a URL (financial app, user
 * 2026-10-09: a span names the ROUTE, never the row). The hash router's
 * path survives as a pattern: `https://app/#/transactions/:id`.
 */
export function scrubUrl(raw: string): string {
  const [beforeHash, ...hashParts] = raw.split('#');
  const base = beforeHash.split('?')[0];
  const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(base)?.[0] ?? '';
  const path = scrubSegments(base.slice(origin.length));
  if (hashParts.length === 0) return `${origin}${path}`;
  return `${origin}${path}#${scrubSegments(hashParts.join('#').split('?')[0])}`;
}

const looksLikeUrl = (token: string): boolean => /^(?:[a-z][a-z0-9+.-]*:\/\/|\/)/i.test(token);

/** `GET https://api/sync/<id>/pull?since=3` → `GET https://api/sync/:id/pull` */
const scrubText = (text: string): string => text.split(' ').map((t) => (looksLikeUrl(t) ? scrubUrl(t) : t)).join(' ');

const URL_KEYS = ['url', 'http.url', 'url.full', 'url.path', 'from', 'to'];
const DROP_KEYS = ['http.query', 'http.fragment', 'url.query', 'url.fragment', 'query_string'];
/** the router integration's route params (`url.path.params.txId` & co) — the pattern is the point */
const PARAM_KEY = /^(?:url\.path\.param|params\.)/;

function scrubBag(bag: Record<string, unknown> | undefined): void {
  if (!bag) return;
  for (const key of URL_KEYS) {
    const value = bag[key];
    if (typeof value === 'string') bag[key] = scrubUrl(value);
  }
  for (const key of Object.keys(bag)) {
    if (DROP_KEYS.includes(key) || PARAM_KEY.test(key)) delete bag[key];
  }
}

function scrubSpan(span: SpanJSON): void {
  if (span.description) span.description = scrubText(span.description);
  scrubBag(span.data);
}

/** the same scrub over everything an event carries: its own url, its
 *  trace data, its breadcrumbs (fetches, navigations) and, on a
 *  transaction, every span */
export function scrubEvent<E extends SentryEvent>(event: E): E {
  scrubBag(event.request as Record<string, unknown> | undefined);
  scrubBag(event.contexts?.trace?.data);
  for (const crumb of event.breadcrumbs ?? []) scrubBag(crumb.data);
  for (const span of (event as TransactionEvent).spans ?? []) scrubSpan(span);
  return event;
}

/**
 * A sync round that moved nothing and stayed under budget is a heartbeat,
 * not a finding — one every 10 s per open tab would drown the Performance
 * view. A SLOW empty round still ships: that is the finding.
 */
export function isIdleSyncRound(event: TransactionEvent): boolean {
  if (event.transaction !== 'sync.round') return false;
  const data = event.contexts?.trace?.data ?? {};
  const moved = Number(data['sync.ops_pushed'] ?? 0) + Number(data['sync.rows_pulled'] ?? 0);
  const ms = ((event.timestamp ?? 0) - (event.start_timestamp ?? 0)) * 1000;
  return moved === 0 && ms <= perfBudget['sync.round'];
}

/** beforeSendTransaction (after the zero-network gate): idle rounds out, every URL scrubbed */
export const transactionFilter = (event: TransactionEvent): TransactionEvent | null =>
  isIdleSyncRound(event) ? null : scrubEvent(event);

/* ── the interaction the person felt ─────────────────────────────────── */

export interface InpSummary {
  /** the page's worst interaction, ms from the tap to the next frame */
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  /** the element, as a selector (never its text) */
  target: string;
  type: 'pointer' | 'keyboard';
  inputDelay: number;
  processingDuration: number;
  presentationDelay: number;
  loadState: string;
  /** the frame's longest script, where the browser attributes it (Chromium) */
  longestScript?: { invoker: string; url: string; fn: string; subpart: string; ms: number };
}

export function summarizeInp(metric: INPMetricWithAttribution): InpSummary {
  const a = metric.attribution;
  const script = a.longestScript;
  return {
    value: Math.round(metric.value),
    rating: metric.rating,
    target: a.interactionTarget,
    type: a.interactionType,
    inputDelay: Math.round(a.inputDelay),
    processingDuration: Math.round(a.processingDuration),
    presentationDelay: Math.round(a.presentationDelay),
    loadState: a.loadState,
    ...(script
      ? {
          longestScript: {
            invoker: script.entry.invoker,
            url: script.entry.sourceURL,
            fn: script.entry.sourceFunctionName,
            subpart: script.subpart,
            ms: Math.round(script.intersectingDuration),
          },
        }
      : {}),
  };
}

// one GlitchTip issue per element: the message names the target, the
// numbers ride as extra on each event
const reportInp = (summary: InpSummary): void => reportWarning('web-vitals', `INP poor: ${summary.target}`, { ...summary });

/**
 * INP is the number behind "Confirm feels slow": the tap to the next
 * frame. The tracing integration ships it as a standalone span GlitchTip
 * has no page for, so a POOR interaction (over 500 ms, web-vitals' own
 * threshold) becomes a warning event with its attribution instead — the
 * element, the three phases and the longest script — once per page life
 * (the browser reports the worst interaction when the page hides).
 */
export function installWebVitals(report: (summary: InpSummary) => void = reportInp, subscribe: typeof onINP = onINP): void {
  let sent = false;
  subscribe((metric) => {
    if (sent || metric.rating !== 'poor') return;
    sent = true;
    report(summarizeInp(metric));
  });
}
