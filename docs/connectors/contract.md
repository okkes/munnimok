# The HTTP contract

The authoritative document is the one the control plane serves:
`/openapi/v1.json`, browsable at `/scalar`. This page is the reading guide —
the conventions the document cannot say — and it is tested against the
document by `Connector.Api.Tests/ApiDocumentTests`.

Everything is JSON in `snake_case`; enums are lower snake strings; nulls are
omitted.

## Headers

| Header | Direction | Where | Meaning |
| --- | --- | --- | --- |
| `Authorization: Bearer …` | request | every `/v1` route, production | the consumer's machine token (see architecture: security) |
| `X-Connector-Key` | request | every `/v1` route, development | the shared secret, when one is configured |
| `X-Connector-Subject` | request | every route naming a session, job, ticket or agent; optional beside a body `subject`, and must then agree | the user the call is made for — opaque to the connector |
| `X-Connector-Ticket` | request | `GET /v1/{provider}/{resource}`, `…/ack` | a ticket from `sessions/resume` |
| `X-Connector-Trigger` | request | login, fetch | `user` (default) or `schedule`; a schedule is held to the provider's `min_interval_seconds` |
| `X-Device-Class` | request | login | `native` (default) or `web`; web bundles live shorter |
| `Idempotency-Key` | request | login | a repeated login with the same key for the same subject returns the same session |
| `X-Manifest-Version` | response | the routes that read a provider's manifest: login, session view, resume, disconnect, fetch, ack, job view | which contract version of that provider answered |
| `ETag` / `If-None-Match` | catalogue | `GET /v1/providers`, `/v1/providers/{id}` | the catalogue changes on a deploy or a health change; revalidate instead of refetching |

## Routes

### Consumer, `/v1`

| Route | What it does |
| --- | --- |
| `GET /providers`, `GET /providers/{id}` | the catalogue: every manifest with its health grafted on |
| `GET /status` | providers (each with `quota` — `limit`, `remaining`, `reset_at`, `seen_at` — when the party last said something about its budget), agents online/revoked, queue depth |
| `GET /{provider}/options/{field}?q=…` | the values of a `lookup` field, listed by the party at connect time (an aggregator's institutions); every other query parameter is context (the step's country); `{ options: [{ value, label, has_logo }] }` |
| `GET /{provider}/options/{field}/{token}/logo` | the option's logo, vendored by the control plane once and cached for a month; `token` is the option's value as base64url (a party may name an option `ASN Bank\|NL`); 404 when the party has none |
| `GET /health` (anonymous, outside the group) | liveness |
| `POST /{provider}/login` | start a session: `subject`, `inputs` or a `credential_bundle`, `config`, `consent`, `prefer_agent`, `label` → 200 with the session (active, bundle attached) or 202 to follow |
| `GET /{provider}/login/{sessionId}` | the session view; hands over the bundle once |
| `GET /{provider}/login/{sessionId}/events` | the same view as server-sent events until terminal or active; never carries the bundle |
| `GET …/challenges/{challengeId}/image` | a challenge's picture (PNG) |
| `POST /{provider}/login/{sessionId}/answer` | `challenge_id`, `value` |
| `POST /{provider}/login/{sessionId}/cancel` | fails the run in flight |
| `GET …/challenges/{challengeId}/live/frame?after=n`, `POST …/live/input` | the live view: newest JPEG frame past `n` (long poll), the human's taps and keys |
| `POST /{provider}/sessions/resume` | `subject`, `bundle` → a ticket (15 min) |
| `DELETE /{provider}/sessions/{sessionId}` | disconnect, with an optional `bundle` for the upstream logout |
| `GET /{provider}/{resource}?…` | fetch with a ticket: 200 data page, 202 job handle, or a challenge; a fetch of a resource already in flight for the session is handed that job's 202 instead of a second run (prod 2026-10-06: a phone reopening the app queued four Amazon fetches behind one another) |
| `POST /{provider}/{resource}:fetch` | one round trip: `subject`, `bundle`, `params` |
| `POST /{provider}/{resource}/ack` | `cursor` → purges the staged rows up to it |
| `GET /{provider}/jobs/{jobId}`, `…/events`, `POST …/answer` | following a fetch that did not finish inside its window; identical contract to a login |
| `POST /{provider}/jobs/{jobId}/artifacts/share`, `DELETE /{provider}/jobs/{jobId}/artifacts` | #441 L1: what a failed run left behind — the last picture of the page (never taken while a secret field holds content) and a digest of the page's shape — is the person's to give. A session or job view whose `artifacts_job_id` is set says a picture waits on their answer; yes retains it for the operator for a month (`{ job_id, expires_at }`), no deletes it, no answer within two days deletes it too, and a disconnect takes the open question with it. Both go through the same subject join as the view |
| `GET /agents`, `POST /agents/enrollment`, `DELETE /agents/{agentId}`, `GET /agents/{agentId}/profiles` | the caller's household agents: list, mint an enrollment code (`subject`, `name`), revoke, profile health — a hosted slot in the caller's list (`hosted`, `bound`) is given back by the delete, never revoked |
| `GET /private-agents/mine`, `POST /private-agents/requests`, `DELETE /private-agents/requests/{requestId}`, `DELETE /private-agents/mine` | hosted private agents (#420 A2): the caller's standing (`offered`, `free`, `request`, `agent`), a request (`subject`; asking twice is one request; refused where no slot exists or one is already theirs), withdrawing a pending one, giving the slot back |

### Operator, `/v1/admin` (admin scope)

| Route | What it does |
| --- | --- |
| `POST /providers/{id}/status` | the kill switch: `state` (`healthy`, `degraded`, `paused`, `retired`), `reason_key`; retiring expires every session |
| `GET /providers/{id}/remote-consents`, `DELETE /providers/{id}/remote-consents/{consentId}` | what the operator's account at the party holds (an aggregator's every consent, with `origin` — the environment that made it — `status`, `reference`, `account_count`) and a revoke for each; `unsupported_resource` for a party that keeps no inventory |
| `GET /canaries`, `PUT /providers/{id}/canary`, `DELETE /providers/{id}/canary` | the operator's own connections that prove a provider still works |
| `POST /canaries/{id}/run` | #441 L1: the canary now, not on its next due minute — the view names the job to follow; refused while its last run is still in flight or the provider is paused |
| `GET /jobs`, `GET /jobs/{jobId}` | #441 L1: the history, newest first, narrowed by `provider`, `subject`, `session`, `state`, `kind`, `trigger` (`user`, `schedule`, `lab`, `canary`, `none`), `code`, `since`, `before` and `limit` (100, up to 500; `truncated` says when the limit cut the list); every column that says what happened — the progress, attempts, the agent, the error with its operator detail, the notes, the validated params and config, what it left behind (`artifacts`: `none`, `pending`, `retained`, with `dom_digest` and `has_screenshot` once retained) — and none of the ones that say what was typed: inputs and material have no field on this view |
| `GET /jobs/{jobId}/artifacts/screenshot` | the picture a failed run left, once retained (PNG, never cached); `unsupported_resource` while pending, once declined, or when none was taken |
| `GET /health` | per-provider health off the month's jobs: windows `24h`, `7d`, `30d` with outcomes, open runs, failures by code, runs by trigger and the people affected (distinct sessions of people's runs that failed — lab and canary runs are the operator's); the last success and failure, sessions by state, the canary's last word, the reports to read and the pictures still waiting on a person |
| `GET /agents`, `DELETE /agents/{agentId}` | every agent, whoever owns it; revoke any |
| `GET /private-agents`, `POST /private-agents/requests/{requestId}/approve`, `POST …/deny`, `POST /private-agents/{agentId}/release` | the hosted slots (`total`, `free`, `slots[{agent, subject}]`) and the requests (pending first, a month of decisions); approving binds the oldest free online wiped slot to the asker (`agent_unavailable` when none); taking a slot back expires the sessions pinned to it and asks the agent to wipe |

### Agent, `/agent/v1` (agent token)

| Route | What it does |
| --- | --- |
| `POST /enroll` | `code`, `name`, `capabilities` → `agent_id`, `token`, `heartbeat_seconds`; the code authenticates this one call |
| `POST /heartbeat` | capabilities, profile health, running count, `reset_done` → lease TTL, `revoked`, `reset_profiles` (a released hosted slot wipes every browser profile, keeps serving and answers `reset_done` on its next beat; asked until it does), the control plane's `catalog_digest` (the agent-served digest: the parties an agent can be leased, raw stripped — never the catalogue's own, which moves with the inline parties and the raw offer) |
| `POST /jobs/lease` | long poll for a job matching the agent's capabilities, or 204 |
| `POST /jobs/{jobId}/renew`, `/progress`, `/challenge`, `GET /jobs/{jobId}/answer`, `POST /jobs/{jobId}/result`, `/fail` | the job's life |
| `POST /jobs/{jobId}/live/frame`, `GET /jobs/{jobId}/live/input?after=n` | the live view from the agent's side |

## Errors

Every failure is one envelope:

```json
{ "error": { "code": "rate_limited", "retriable": true, "user_action": "wait",
             "message_key": "connect.error.rate_limited", "retry_after_seconds": 3540 } }
```

`message_key` is what the consumer localises; `detail_id` names a log entry
for an internal failure; nothing in the envelope is prose. The table is the
kit's `ErrorCatalog`:

| `code` | HTTP | retriable | `user_action` |
| --- | --- | --- | --- |
| `invalid_credentials` | 401 | no | `reauth` |
| `session_expired` | 401 | no | `reauth` |
| `mfa_failed` | 401 | no | `reauth` |
| `mfa_timeout` | 408 | yes | `retry` |
| `challenge_expired` | 410 | yes | `retry` |
| `blocked_by_provider` | 403 | no | `wait` |
| `provider_changed` | 502 | no | `wait` |
| `provider_unavailable` | 503 | yes | `retry` |
| `rate_limited` | 429 | yes | `wait` |
| `agent_unavailable` | 503 | yes | `start_your_agent` |
| `agent_revoked` | 403 | no | `reconnect` |
| `unsupported_resource` | 400 | no | `none` |
| `invalid_request` | 400 | no | `none` |
| `consent_expired` | 403 | no | `reconnect` |
| `reconciliation_failed` | 502 | no | `wait` |
| `internal` | 500 | yes | `retry` |

A thing that is not the caller's — somebody else's session, job, ticket or
agent — is `unsupported_resource`, exactly as a thing that does not exist.

## Challenges

A challenge is the provider asking the human something. `type`:

| `type` | The human… | `answer_kind` |
| --- | --- | --- |
| `mfa_code` | types the code from an SMS, an e-mail or an authenticator (`delivery`, `length`) | `text` |
| `code_display` | reads a code shown here and types it somewhere else | `text` (acknowledgement) |
| `qr_display` | scans a picture with the provider's app | passive |
| `app_approval` | approves in the provider's app; the agent waits | passive |
| `image` | looks at a picture and answers — a captcha, a "pick the taxis" grid | `text`, or `taps` (`tap.v1:x,y;x,y;submit`, fractions of the picture) |
| `select_option` | picks one of `options` | `text` (the option's value) |
| `redirect` | finishes something at `url` and comes back (`return_pattern`) | `text` |
| `live_view` | drives the provider's own page through a relayed picture | the frame and input routes |

Every challenge carries `expires_at`; the agent waits for the answer up to
it, and a challenge nobody answered fails the job `mfa_timeout`.

## Records

A fetch page is `{ resource, data: { items: [...] }, cursor, complete, notes,
session? }`. Items are the kit's normalisation records, one shape per
resource as the catalogue's `returns` says: `account`, `transaction`,
`receipt` (lines, totals, an optional invoice document), `credit_registration`
(BKR), `student_debt` (DUO). Their schemas are in the OpenAPI document under
`components/schemas`. Amounts are minor units with a currency; hashes make
a record stable across fetches so a consumer can reconcile.

## Idempotency and streams

A login repeated with the same `Idempotency-Key` for the same subject and
provider returns the existing session rather than a second one. Streams
(`…/events`) send the same view the poll returns, one event per change, and
end when the view is terminal (or active, for a login); a stream never hands
over a bundle, because a stream cannot acknowledge receipt.
