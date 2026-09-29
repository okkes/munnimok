# The relay

The app never talks to the connector control plane. It talks to the munni
API, and the API's `Connectors/` slice (`server/src/Munni.Api/Connectors`)
carries every call across: it mints the subject, binds sessions to the
signed-in user, passes bundles through memory and back, files what a sync
fetched into the feeds, and bridges the connector's event streams into the
one stream the app already holds. This page is written from that code
(docs/connector-integration-plan.md §5 is the plan it delivers; §14 records
where it departs).

## Configuration (`Connectors:*`)

| Key | Meaning |
| --- | --- |
| `BaseUrl` | The control plane's root on the environment's network. Absent, the relay is not mapped and `/health` reports `capabilities.connectors: false`. |
| `SubjectSalt` | Per-environment secret the user id is HMAC-ed with. Required once `BaseUrl` is set; rotating it severs every connection of the environment. |
| `DevKey` | Development transport: the shared secret sent as `X-Connector-Key`. |
| `M2mAppId`, `M2mAppSecret`, `Audience` | Production transport: a Logto machine-to-machine application minting a client-credentials token for the connector's audience (`Auth:Authority` names the issuer). Required when `DevKey` is empty. The token is minted once and reused until a minute before it expires. |
| `AgentPublicUrl` | Where a household agent dials in from the outside, as the platform publishes it. Absent, enrollment answers a code with no address and the app says household agents are not offered here. |
| `LoginsPerHour`, `SyncsPerHour` | Per-user budgets on the two calls that reach a party (defaults 10 and 12), on top of the connector's own per-provider interval. |
| `TimeoutSeconds` | One call's ceiling (default 60; a fetch waits at most 25 s at the control plane before it answers 202). |

A configured relay with a setting that cannot be right (a base URL that is
not one, no salt, half a machine pair) refuses to start with the setting's
name. One whose machine pair has not been written back yet — the platform's
Logto module does that after the environment's first bootstrap — starts
with the relay off and says so in its log; the next start finds the pair.
An unconfigured one is simply absent — never a stand-in.

## What the relay guarantees

- **The subject is minted, never sent.** `u_` + 21 characters of
  base64url(HMAC-SHA256(salt, user id)). The control plane never learns a
  user id, an e-mail or a name.
- **A session route answers only its owner.** `POST login` binds
  `(session, user, provider, connection)` in `ConnectorSessions`; every
  `{sessionId}` route is 404 `unsupported_resource` for anyone else and for
  an id that does not exist — one answer for both. Sync and disconnect are
  bound through the bundle itself (the connector rejects a foreign subject).
- **Bundles pass through memory only** — with one documented exception. The
  two tables the relay owns hold ids, state and references; a test walks
  their properties and the rows after every flow and finds no bundle.
  The exception is a household agent's bundle (`secret_custody: agent`): it
  names an agent and a profile and holds no secret, so the relay keeps it
  on the session row to sync unattended ("Scheduled syncs" below); the
  same scan proves a client-custody bundle never lands there. Nothing the
  relay logs carries a body.
- **One connection, one row.** The client names a stable `connectionId` on
  every login; a re-login replaces the connection's row, and what the
  connection pulled stays keyed by it (`rcpt:{provider}:{connectionId}:{external id}`).
- **Every document is in this API's casing.** The connector speaks
  snake_case; the relay renders sessions, jobs, challenges, the catalogue and
  the error envelope in camelCase. Data-bearing objects — `config`, `inputs`,
  `params`, `raw` — keep their keys verbatim.
- **Errors keep the connector's envelope and status**:
  `{ error: { code, retriable, userAction, messageKey, detailId, retryAfterSeconds } }`,
  with `Retry-After` when there is a wait. The relay's own refusals speak the
  same envelope: `rate_limited` (429) for the budget, `unsupported_resource`
  (404) for a session that is not yours, `provider_unavailable` (503) when the
  control plane cannot be reached.

## Routes (`/connectors`, signed-in user)

| Route | What it does |
| --- | --- |
| `GET /connectors` | what this environment runs: the service descriptor, the provider count, whether household agents are offered |
| `GET /connectors/providers` | the catalogue, with the connector's ETag (send `If-None-Match`, get 304) |
| `GET /connectors/sessions` | the caller's bindings: session, provider, connection, state, label, times, and whether the relay syncs it by itself (`scheduled`, `lastScheduledSyncAt`, `lastScheduleError`) |
| `POST /connectors/{provider}/login` | `{ connectionId, inputs?, credentialBundle?, config?, label?, preferAgent?, idempotencyKey? }` → the session view; 200 with the bundle attached, or 202 to follow. `X-Device-Class: native\|web` is honoured; absent, the platform header decides (web bundles live shorter) |
| `GET …/login/{sessionId}` | the view; the bundle is handed over exactly once |
| `POST …/login/{sessionId}/answer` | `{ challengeId, value }` |
| `POST …/login/{sessionId}/cancel` | fails the run in flight |
| `GET …/login/{sessionId}/challenges/{challengeId}/image` | the picture |
| `GET …/challenges/{challengeId}/live/frame?after=n`, `POST …/live/input` | the live view: the newest JPEG frame past `n` (`X-Live-*` headers relayed), the human's taps and keys |
| `POST /connectors/{provider}/sync` | `{ connectionId, bundle, since? }` → resume, fetch every resource the manifest declares, ingest, acknowledge; 200 `{ sessionId, state, ingested, session? }` — `session.bundle` only when the provider rotated it, and then the app persists it; 202 `{ jobId, … }` when a fetch outran its window or stopped for a question |
| `GET …/jobs/{jobId}` | the job's view, without its page of records |
| `POST …/jobs/{jobId}/answer` | `{ challengeId, value }` |
| `POST …/jobs/{jobId}/collect` | `{ bundle }` once the job succeeded: ingests its page, acknowledges it, hands back the rotated bundle; 202 with the view while it runs |
| `DELETE /connectors/{provider}/sessions/{sessionId}` | `{ bundle? }` → `{ loggedOut, jobId?, reason? }`; the binding row is removed. Reaches the control plane row or no row: a caller must always be able to remove a connection |
| `GET /connectors/agents`, `POST /connectors/agents/enrollment`, `DELETE /connectors/agents/{agentId}`, `GET …/{agentId}/profiles` | the caller's household agents; enrollment answers `{ code, expiresAt, controlPlaneUrl, composeCommand }` — the one line beside `deploy/connectors/household-agent.yml` |

## Scheduled syncs

Client custody syncs only when a device holds the bundle: the app on open,
*Sync now*, after a bank sync. A household-agent party is different —
its bundle is a pointer to an agent and a profile on the person's own
machine, and the agent does the fetching — so the relay keeps that bundle
(`ConnectorSession.KeptBundle`, written at the single delivery and
followed through every rotation) and `ConnectorScheduleService` drives it
the way `GcFetchService` drives open banking:

- an hourly tick over every kept and active session; a session runs when
  the provider fetches unattended and its own `min_interval_seconds` has
  passed since the last scheduled run — and the fetches declare
  `X-Connector-Trigger: schedule`, so the control plane holds them to the
  interval as well (a refusal is remembered, not fought);
- a fetch that became a job is followed for ten minutes and collected
  with the kept bundle; a job that asks a question leaves the session
  `awaiting_input` — the app's card says so and *Sync now* answers it;
- a refusal the person must act on (`session_expired`,
  `invalid_credentials`, `mfa_failed`, `consent_expired`,
  `unsupported_resource`, `agent_revoked`) drops the kept bundle and marks
  the session `needs_reauth`; `blocked_by_provider` marks it `blocked`;
  every other refusal is kept as `lastScheduleError` and retried next tick;
- `GET /connectors/sessions` reports `scheduled`, `lastScheduledSyncAt` and
  `lastScheduleError` per binding.

## Events

Whenever the relay answers with a run still in flight — a login that stopped
to ask, a fetch that became a job — it opens the connector's event stream
for it and republishes every change of the view on `/sync/events` for that
user as

```
data: { "kind": "connector", "provider": …, "sessionId": …, "jobId"?: …, "state": …, "challenge"?: …, "progress"?: …, "error"?: … }
```

never with a bundle or a page of records on it. A client that reads
`/sync/events` for space changes ignores these frames (they carry no
`spaceId`). One bridge per session or job, held at most the control plane's
own ten minutes, gone when the view is terminal. There is no second
EventSource and no per-session stream on the relay.

## Ingest

The server is one more device: every record becomes a sync op with a
deterministic id (`conn:{entity}:{content hash}`), so a re-fetch is a no-op
and a crash between fetch and acknowledgement costs one sync, never a
connection. A page is filed per record by the connector's own id prefix
(`acc_`, `txn_`, `rcp_`, `crd_`, `sdt_`) — a bank's transactions pass
carries its accounts too.

| Record | Lands as | Where |
| --- | --- | --- |
| receipt | `receipt` row: `source` = provider, `date` (the merchant's day), `totalCents`, `currency`, `merchant`, `items` (with `kind` for a line that is not a product), `payment`, `storeRef`, `instanceId` = connection, `documents[]` (`mime`, `dataUrl`, `filename`, `sizeBytes`) when the manifest offers invoices | the owner's store feed (`feed:STORES:{sub}`, registered like `POST /feeds`) |
| account | `account` row: `source: connector`, `provider`, `iban`, `currency`, name and type seeded once, `balanceCents`/`balanceAsOf`, `lastSyncedAt` | the IBAN's feed (co-owned when someone else connected it first); a card or wallet without an IBAN in a personal `CONN:{provider}:{external id}` feed |
| transaction | `transaction` row: `accountId`, `date`, `amountCents`, `currency`, `merchant`, `description`, `importRef`, `counterIban` | the account's feed; `ConnectorAccountRefs` remembers which feed and row each connector account id maps to, so a job collected later files its rows |
| credit_registration | a liability `account`: type from the registry's kind (instalment → loan, revolving/deferred → credit, mortgage, lease → loan), `originalCents` = the registered amount, `balanceCents` the same while running and 0 (archived) when ended, `paymentCents`/`paymentEvery` when stated, `note` with the registry's own label and arrears code | the personal registry feed (`feed:REG:{sub}`) |
| student_debt | a `loan` account named after the provider: `balanceCents` = the total, `interestPctYear`, `note` with the phase | the personal registry feed |

Attaching to a space stays the user's explicit step; ingest never writes a
link and never an overlay.

## Operator (`/admin/connectors`, `/control/connectors`, the `admin` scope)

| Route | What it does |
| --- | --- |
| `GET /admin/connectors/status`, `GET /control/connectors/status` | the control plane's status: providers with their health, agents online, the queue, plus `relay.openStreams` |
| `POST /admin/connectors/providers/{id}/status` | the kill switch: `{ state: healthy\|degraded\|paused\|retired, reasonKey? }`; the operator and the reason go to the server log |
| `GET /admin/connectors/agents`, `DELETE /admin/connectors/agents/{id}` | every household agent, whoever owns it; revoke any |
| `GET /admin/connectors/canaries` | the operator's own connections that prove a party still works |
| `GET /admin/connectors/users/{sub}/sessions` | one user's bindings — the same rows `GET /admin/users/{sub}/diagnosis` now carries as `connectorSessions` |

In production the machine token the relay mints must carry the control
plane's admin scope (`connector:admin`) for these routes; the platform (M2)
grants it to the M2M application.

## Tests

`server/tests/Munni.Api.Tests/Connectors/` boots the real control plane
in-process — `Connector.Kit.Hosting` with every shipped pack, Sqlite,
development auth — behind the relay's HttpClient, and drives the mock
providers through the relay: the catalogue and its ETag, login and binding,
a stranger's 404s, receipts, bank and registry syncs into the feeds, the
captcha and SMS flows with their events, the slow fetch as a job, the
two-factor fetch answered through the job, the kill switch, the fleet, the
enrollment command, the budget, and the write-path scan.
