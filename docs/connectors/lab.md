# The connector lab (`apps/lab`, #441)

The lab is the fifth app: the operator's workbench for the connector
platform. It shows which parties work and which are degraded or broken,
lets an operator run a party end to end on the pooled agents or on a
household agent, records what a browser session does so an adapter can
be built or fixed from the trace, and checks what a household agent
keeps. It replaces the admin portal's Connectors screen — the portal's
tab hands over to it — and the `munniscrape/demo-client` it was
inspired by.

Written from the code and kept in step with it; a claim here the code
does not make is a bug in this file.

## Where it runs

- One lab per environment, beside the admin portal: service
  `lab-<env>`, image `munni-lab`, host `munni-<env>-<platform>-lab`,
  port `8388 + 100·slot` (`infra/modules/stack.mjs`). Locally
  `npm run dev -w @munni/lab` on port 5177 against the local compose
  (its api lists the origin).
- The same account and the same `admin` scope as the portal and the
  cockpit: a Logto SPA app of its own (`VITE_LOGTO_APP_ID_LAB`, written
  back by `infra/modules/logto.mjs`), a crash project of its own
  (`<stack>-lab`, `VITE_GLITCHTIP_DSN_LAB`). Nothing baked: the runtime
  overlay (`MUNNI_*`) configures one image for every stack.
- The app is a plain SPA (React, Vite, Vitest, hash routes) that
  shares no runtime code with the member app; its tests run in the Web
  CI job beside the admin's and the cockpit's, under the same coverage
  floor.

## The lab subject

Every run the lab starts belongs to a **lab subject** minted per
operator — `SubjectMinter.ForLab`: the same HMAC as the app's subject
over `lab:` + the user id. The control plane knows the lab as that
pseudonym and never as the person; the person's own connections in the
app are another subject entirely, so nothing the lab connects, fetches
or records shows up in the app or is ingested into a space.
`GET /lab/me` names it.

## The relay (`/lab`, the `admin` scope)

`server/src/Munni.Api/Connectors/ConnectorLabEndpoints.cs`, mapped only
when the environment runs connectors; `GET /lab/ping` (`Admin/LabEndpoints.cs`)
is mapped always, so the lab tells "no admin scope" (403) apart from
"this environment runs no connectors" (the relayed routes answer 404).

| Route | What it does |
| --- | --- |
| `GET /lab/ping` | 200 `{ admin: true }` for an admin, 403 otherwise — the lab's first call |
| `GET /lab/me` | `{ subject, name, email }` — the operator's lab subject and who sits behind it |
| `GET /lab/status`, `GET /control/connectors/status` | the control plane's status: providers with their health and budget, agents online, the queue, plus `relay.openStreams` |
| `GET /lab/providers`, `GET /lab/providers/{id}` | the catalogue with every manifest and its status beside it — what the Providers screen and the test bench read |
| `POST /lab/providers/{id}/status` | the kill switch: `{ state: healthy\|degraded\|paused\|retired, reasonKey? }`; the operator and the reason go to the server log |
| `GET /lab/providers/{id}/remote-consents`, `DELETE …/{consentId}` | what the operator's account at the party holds (§15), every consent with its `origin`; a revoke, logged with the operator |
| `GET /lab/agents`, `DELETE /lab/agents/{id}` | every agent whoever owns it (the fleet, the people's own machines, the hosted slots); revoke any |
| `POST /lab/agents/enrollment` | a one-time enrollment code **under the lab subject** with the household compose line — the operator's own test machine, serving the lab's runs and nobody else's |
| `GET /lab/private-agents`, `POST …/requests/{id}/approve`, `POST …/requests/{id}/deny`, `POST …/{agentId}/release` | hosted private agents (#420 A2), with who holds each slot (the relay maps the pseudonym to the person per call and stores it nowhere) |
| `GET /lab/canaries` | the operator's own connections that prove a party still works |
| `GET /lab/users/{sub}/sessions` | one user's bindings — the rows the admin diagnosis carries as `connectorSessions` |

The cockpit (`apps/control`) keeps its read-only `/control/connectors`
twin: the status and an aggregator's inventory, never a write.

## The screens (slices L0–L1)

- **Dashboard** — parties accepting work, agents online, jobs in flight
  and awaiting input, open event streams; every party with its state,
  since when and why; the environment's build, protocol and capabilities.
  An environment without connectors says so.
- **Providers** — every party banks first: its name and id, kind, tier
  (`T1 http` … `T4 browser persistent`), where it runs (inline, the
  fleet with its egress claim, the person's own machine; a headed login
  when the party demands one), state, since, budget; the kill switch per
  row (pause, resume, mark healthy, retire behind the typed id).
- **Provider** — the manifest's promises as facts (custody, unattended
  fetch, web support, logout, credential store, auth flow, session shape,
  the challenges it may raise, login origins, limits), the sign-in fields
  with their step, type and secrecy, the resources with their params and
  caps, the status with the kill switch and an optional reason key, the
  inventory (loaded on demand, revoke asks first and names the origin),
  the canary that proves it.
- **Agents** — online of total, pooled against own machines and hosted
  slots; every agent with class, health (revoked, stale catalogue,
  online, offline), heartbeat freshness and the logins it keeps, revoke
  with the cost named; the private slots with their requests (approve,
  deny) and holders (take back); **Enrol a browser for the lab** — a code
  under the lab subject and the compose line, copyable.
- **Canaries** — party, resource, interval, last run, verdict; L1: run
  now per row, the last run a link.
- **Jobs** (L1) — every run the control plane made, newest first: who
  asked (a person by name — the relay maps the pseudonym, the control
  plane never learns it — the schedule, the lab, a canary), the party,
  the run, how it ended, what it left behind; narrowed by party, state,
  kind, trigger, code and user, the filters living in the hash
  (`#/jobs?provider=ah&state=failed`) so a narrowed list is a link. A
  run in full: the facts, the error with its operator detail, what the
  adapter said, what it asked for, and the picture — shown once the
  person reported it (fetched with the lab's credentials), named as
  waiting while they have not. What was typed is on no view.
- **Provider** (L1) — a Health card: the last day, week and month by
  runs, successes, failures, open runs, people affected and who asked;
  failures today by code as the wire spells them; the last success and
  the last failure (a link to the run); sessions by state; the reports
  to read and the pictures awaiting the person; `every run →` into the
  narrowed history; the canary card runs the canary now.
- **Dashboard** (L1) — failed runs today with the people affected, and
  the failure reports to read.
- **Settings** — the operator, the lab subject, the sign-in mode, the
  api, the build and the identity provider.

## What follows (the plan on #441)

L1 done (2026-10-06: the job history, per-party health, failure reports
with the person's consent — see architecture.md "Failure reports" — the
lab trigger, canary run-now, one fetch in flight per session and
resource); L2 the
test bench (connect with challenges and the live view, agent targeting,
fetch and records by shape, lab sessions, lab-managed canaries); L3 the
recorder (record-a-run, the Explore job, trace storage and viewer, the
digest an adapter author reads); L4 the household-agent retention bench;
L5 the new-service wizard with the adapter scaffold.
