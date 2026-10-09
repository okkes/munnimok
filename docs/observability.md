# Observability: errors and performance in one place

The user's ask (2026-10-09): *"Review → Confirm takes 3–4 seconds,
sometimes nothing happens. Monitor production so the slow path is
visible with numbers, and catch slow paths during development."*

The decision: stay on the Sentry protocol and switch on **performance
tracing** into the GlitchTip every environment already reports its errors
to. One vendor, one dashboard, no new cost; the same gates and the same
scrubbing rules the crash reports follow. This page says what is traced
where, how much, how to read a slow Confirm, what the developer's
machine catches, and which spans still have to be added.

## 1. What is traced where

| Where | Transactions (root spans) | Child spans | Notes |
| --- | --- | --- | --- |
| **web** (`apps/web`) | every **pageload** and **navigation**, named by the route *pattern* (`/transactions/$txId`, `/review`) through `tanstackRouterBrowserTracingIntegration` | the fetches it triggers, long animation frames with the script that caused them (`ui.long-animation-frame`), long tasks on browsers without LoAF, resource timings | an idle route with no activity ends its transaction after 1 s; interactions minutes later are NOT inside it — that is what the custom spans below are for |
| web | **`sync.round`** (op `munni.sync`): one per push/pull round (`sync/engine.ts`) | `sync.handshake` (the `/health` protocol check), `sync.spaces` (`/me/spaces`), per space `sync.push` (`sync.ops`) and `sync.pull` (`sync.rows`), with the HTTP spans under them | attributes `sync.spaces`, `sync.ops_pushed`, `sync.rows_pulled`, `sync.ok` — counts only, never contents; a round that moved nothing and stayed under its 2 s budget is dropped before it leaves (`isIdleSyncRound`): one per 10 s per open tab would drown the view, a *slow* empty round still ships |
| web | **`app.boot`** (op `munni.app`): `app/data.tsx`, the identity's store open to the first screen | `app.boot.open` (Dexie / SQLCipher open + migrations), `app.boot.seed` (demo), and `app.boot.heal` as its own transaction (the every-boot heals outlive the boot) | attributes `boot.identity` (demo/offline/user), `boot.spaces`, `boot.waited_for_server` (a brand-new device waits for the bootstrap pull), `boot.cancelled` (StrictMode's first mount) |
| web | **custom spans** through `measure()` (`lib/perf.ts`) — the sites in §7 | nested `measure()` calls and the fetches under them | a root `measure` becomes a transaction; a nested one a row in the parent's waterfall |
| web | **INP** — a *poor* interaction (> 500 ms from the tap to the next frame) | — | not a transaction: one **warning event** per element (`scope: web-vitals`, message `INP poor: button[data-testid="review-confirm"]`) with the value, the three phases (input delay / processing / presentation), the load state and the longest script's function and invoker, once per page life, reported when the page hides. GlitchTip has no Web Vitals page and does not render the SDK's standalone INP spans, so the event is how the number reaches an issue list |
| **api** (`Munni.Api`) | every sampled request, named by its **route template** (`POST /sync/{spaceId}/push`, `GET /receipts/{id}`, `POST /connectors/...`) — Sentry.AspNetCore's tracing middleware | EF Core queries (`db.query`, the parameterised SQL — no values) and every `IHttpClientFactory` call (`http.client`: Logto, the connector relay, logo.dev, OCR, FCM, the quote providers) — the SDK's DiagnosticSource listener and `SentryHttpMessageHandler`, both bundled in `Sentry` 6.x | health probes and the SSE stream are never a transaction (`SentryNoise.IsHeartbeat`); a trace the web app started keeps its sampling decision (`SentryNoise.SampleTrace`) so a sampled `sync.round` shows its push on the api under the same trace id |
| **connector control plane** (`Connector.Api`) | every sampled request of the relay (`/v1/...`) | its database and party calls | `/v1/health` (docker every 10 s), the operator's `/health` and the agents' `/heartbeat` never count; **no trace header leaves the process** — a bank's or a shop's site is nobody's tracing peer |
| **browser agents** (`Connector.Agent`) | none automatically (a generic host) | — | the rate is wired so a future job-level transaction (Connector.Kit.Hosting `Jobs/*`) works without a config change; trace headers may reach the control plane only |
| admin, lab | errors only (unchanged) | | |

Op names group the web's custom transactions in GlitchTip:
`munni.review`, `munni.sync`, `munni.planning`, `munni.receipts`,
`munni.app` — the part before the first dot of the span name.

## 2. How much: the sample rates

One share per environment, in the committed platform config
(`infra/platforms/<platform>/envs/<env>.json`):

```json
"tracing": { "sampleRate": 0.2 }
```

Defaults when the key is absent: **0.2 on a `production` app channel,
1 on a staging one** (the test ground wants every trace), `0` = errors
only. The wizard renders the same value into every container of the
environment with a Deploy:

| Container | Variable | Read by |
| --- | --- | --- |
| web | `MUNNI_TRACES_SAMPLE_RATE` → `/runtime-config.js` → `config.tracesSampleRate` | `main.tsx` `tracesSampleRate` (without an overlay: `VITE_TRACES_SAMPLE_RATE`, else 0.2 on the production channel and 1 elsewhere — the native shells bake this) |
| api | `Sentry__TracesSampleRate` | `Program.cs` → `SentryNoise.TracesSampleRate` + `SentryNoise.SampleTrace` |
| connector | `Sentry__TracesSampleRate` | `Connector.Api/Program.cs` (the same rule, heartbeats excluded) |
| connector-agent-\*, connector-private-\* | `Sentry__TracesSampleRate` | `Connector.Agent/Program.cs` |

A value that is not a number in 0..1 is refused by the wizard
(`normalizeEnv`) and, on the servers, read as the 0.2 default.

Local docker stacks (`docker-compose.local.yml`) carry no DSN, so nothing
is sent; the dev server traces at 1 when `VITE_GLITCHTIP_DSN` is set.

## 3. The rules that still hold

* **Zero-network identities send nothing** — not a transaction, not a
  span. Three layers: `beforeSend` and `beforeSendTransaction` return
  `null` for a demo/offline identity, and the transport itself is gated
  (`gateTransport` in `lib/report.ts`, under the offline queue) because
  the SDK sends standalone INP spans through no hook at all.
* **Routes, never rows.** `scrubEvent` (`lib/perf.ts`) runs on every
  error and transaction: the event url, the trace data, breadcrumbs and
  every span lose their query, fragment and id-shaped path segments
  (`/sync/:id/pull`, `/#/transactions/:id`), and the router integration's
  route parameters are deleted. A transaction's *name* is the route
  pattern by construction.
* **No bodies, no input.** `sendDefaultPii` stays off everywhere; span
  attributes are names, counts and durations. EF spans carry
  parameterised SQL. The INP report names an element by selector, never
  its text.
* **Trace headers go to our own services only.** The web propagates
  `sentry-trace`/`baggage` to `config.apiUrl` alone (the api's CORS
  allows any header — Logto's does not, and a party must not see them);
  the api propagates to the connector control plane only; the control
  plane to nobody; an agent to its control plane only.
* **Heartbeats are not transactions**: `/health`, `/v1/health`,
  `/sync/events`, `/heartbeat`.

## 4. Reading a slow Confirm in GlitchTip

GlitchTip (the shared stack runs `glitchtip/glitchtip:latest`, see
`infra/modules/render.mjs`) has shown transactions since 1.3; there is
nothing to enable in the UI — the Performance page lists transaction
groups as soon as an SDK sends them with a sample rate above 0. The
retention is `GLITCHTIP_MAX_TRANSACTION_EVENT_LIFE_DAYS` (inherits
`GLITCHTIP_MAX_EVENT_LIFE_DAYS`, 90 days); set it in the shared stack's
`&glitchtip_env` block if the volume ever matters.

1. Open the environment's web project (`<stack>-pwa`, e.g.
   `munni-nas-prod-pwa`) → **Performance**.
2. Find the transaction group **`review.confirm`** (op `munni.review`)
   once the lead's span lands (§7). The group shows count, average and
   p95; sort by p95 to see the worst.
3. Open a slow one: the waterfall shows what the confirm did — the
   nested `measure` rows (receipt settle, planning rebuild, …), any
   fetches, long animation frames with `browser.script.invoker` /
   `browser.script.source_function_name`. The attributes carry
   `munni.ms`, `munni.budget_ms`, `munni.over_budget`.
4. If the slowness is the sync after it, look at **`sync.round`** (op
   `munni.sync`): its `sync.push` child names the ops count and the
   `POST /sync/:id/push` fetch under it; the api project
   (`<stack>-api`) has the server half under the **same trace id**
   (`POST /sync/{spaceId}/push` with its `db.query` spans) — the web's
   trace decides the sampling of both.
5. The **Issues** list of the web project holds the INP warnings
   (`scope: web-vitals`): one issue per element, each event with the
   value and the phases. A high `processingDuration` with
   `longestScript.fn` is JavaScript on the main thread; a high
   `presentationDelay` is layout/paint after it; a high `inputDelay` is
   the thread being busy *before* the tap.
6. Filter by `environment` (production / staging / local) and by the
   `space.period` tag (month / week / biweekly / custom) when the period
   math is suspected; `release` carries the build number.

## 5. The dev-time catch

`lib/perf.ts` exports `perfBudget`, what each hot path may take:

| Span | Budget |
| --- | --- |
| `app.boot` | 1 500 ms |
| `review.confirm` | 300 ms |
| `sync.round` | 2 000 ms |
| `planning.build` | 150 ms |
| `receipts.match` | 500 ms |

* `measure(name, fn)` times `fn` with `performance.now()` whether or not
  Sentry is on. On the **dev server** an overrun prints
  `[perf] review.confirm took 812 ms (budget 300 ms)` in the console
  (`slowLog`); production builds and the test runner stay quiet, and the
  span is tagged `munni.over_budget` for GlitchTip.
* `mark(name, ms)` records an ad-hoc number (a phase, a count that
  explains a duration) on the active transaction and runs the same
  budget check.
* `setSlowLogSink(fn)` redirects the warnings (tests do).

## 6. The perf harness and `npm run perf`

`apps/web/src/test/perfHarness.ts` builds a **deterministic** large store
in fake-indexeddb — 1 500 transactions (18 months, the newest sixty
awaiting review, a share linked to recurrings), 300 receipts (half of
them twins of a transaction so the matcher has work), 40 recurring rows —
every row with a proper sync envelope, written in bulk so the seed is
cheap. Same seed, same rows, same HLC stamps every run.

A timed unit test (headroom for CI boxes):

```ts
// @vitest-environment happy-dom
import { buildPerfStore, timeIt } from '@/test/perfHarness';
import { perfBudget } from '@/lib/perf';

it('builds the planning model for a period within budget', async () => {
  const data = await buildPerfStore();
  const { ms } = await timeIt('planning.build', async () => buildPlanning(await loadPlanningData(data.store, data.spaceId)));
  expect(ms).toBeLessThan(perfBudget['planning.build'] * 4);
  data.close();
});
```

A benchmark (`src/**/*.bench.ts`, run by `npm run perf` in `apps/web`,
apart from the unit suite; vitest 5 hands `bench` to a regular test as
a context fixture):

```ts
import { describe, test } from 'vitest';
import { buildPerfStore } from '@/test/perfHarness';
describe('receipt matching', () => {
  test('rematchSpaces over 300 receipts', async ({ bench }) => {
    const data = await buildPerfStore();
    await bench('rematchSpaces', async () => { await rematchSpaces(data.store, data.repo, [data.spaceId]); }).run();
    data.close();
  });
});
```

`src/lib/perf.bench.ts` measures the instrumentation's own overhead
(`measure()` around a trivial function, `scrubEvent` over a 50-span
transaction) so the script has something to run from day one.

## 7. Span sites still to add (after the parallel agents land)

Paste-ready wrappers for the files other agents own right now; each
becomes a transaction (or a row in one) under the ops of §1.

| Site | File | Wrapper |
| --- | --- | --- |
| the review deck's Confirm | `features/review/ReviewScreen.tsx`, `const confirm = async () => { … }` | `const confirm = () => measure('review.confirm', async (span) => { /* existing body */ span.setAttribute('review.queue', queueLen ?? 0); });` |
| receipt settle inside the confirm | same file, the `settleReceipt` call | `await measure('review.confirm.receipt', () => settleReceipt(...))` |
| receipt matching | `application/receiptMatching.ts`, where `createMatchScheduler` runs a pass | `await measure('receipts.match', (span) => { span.setAttribute('receipts.spaces', ids.length); return rematchSpaces(storage, repo, ids); })` |
| the planning model | `application/planningModel.ts` call sites (`usePlanningOps`, the planning screen's query) | `const data = await measure('planning.load', () => loadPlanningData(store, spaceId)); const model = measure('planning.build', () => buildPlanning(data, today));` |
| a receipt attach | `application/receiptLinks.ts` `attachReceiptTo` call sites (ReceiptPickSheet, the review card) | `await measure('receipts.attach', () => attachReceiptTo(repo, spaceId, receipt, txId))` |
| the boot heals, per heal | `app/data.tsx` `app.boot.heal` (already a transaction) | `await measure('app.boot.heal.transfers', () => linkTransferPairs(store, repo), undefined, { parent: heal })` for each heal if one of them turns out to be the slow one |

On the api, every endpoint is already a transaction; child spans for its
phases, where a slow endpoint needs explaining:

```csharp
// SyncEndpoints push: the apply loop as a phase of the request
using var apply = SentrySdk.GetSpan()?.StartChild("sync.apply", $"{ops.Count} ops");
```

```csharp
// ConnectorIngest: the ingest as a phase of the relay call
using var ingest = SentrySdk.GetSpan()?.StartChild("connector.ingest", provider);
```

`SentrySdk.GetSpan()` is null when the request was not sampled, so the
`?.` keeps the phase free.

## 8. Files

* `apps/web/src/lib/perf.ts` — `measure`, `mark`, `slowLog`,
  `perfBudget`, `scrubEvent`, `transactionFilter`, `installWebVitals`,
  `tagSpacePeriod`; tests in `perf.test.ts`, the bench in
  `perf.bench.ts`.
* `apps/web/src/lib/report.ts` — `gateTransport` beside `reportError` /
  `reportWarning`.
* `apps/web/src/main.tsx` — the Sentry init (tracing integration, rates,
  propagation targets, the three gates, `installWebVitals`).
* `apps/web/src/app/config.ts` — `tracesSampleRate`;
  `deploy/nginx/40-runtime-config.sh` passes `TRACES_SAMPLE_RATE` into
  the overlay.
* `apps/web/src/sync/engine.ts`, `apps/web/src/app/data.tsx` — the
  spans of §1.
* `apps/web/src/test/perfHarness.ts` — §6.
* `server/src/Munni.Api/Program.cs`, `SentryNoise.cs` (+ tests),
  `server/src/connectors/Connector.Api/Program.cs`,
  `Connector.Agent/Program.cs`.
* `infra/modules/stack.mjs` (`tracing`), `infra/modules/render.mjs`
  (the four env lines), `infra/platforms/README.md`.
