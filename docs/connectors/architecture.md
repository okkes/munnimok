# Architecture

## Two planes

**The control plane** (`Connector.Api`, library `Connector.Kit.Hosting`) is
the only thing a consumer talks to. It serves the catalogue, turns a login or
a fetch into a job, relays the questions a provider asks to the consumer and
the answers back, stages results until they are acknowledged, and keeps the
fleet. It holds Postgres (Sqlite in development) and nothing else.

**The data plane** is agents (`Connector.Agent`, library
`Connector.Kit.Agent`): processes that enroll with a control plane once, then
heartbeat, lease jobs, drive providers with the adapter code they carry, and
post results. Every call is outbound from the agent; the control plane never
connects to one.

Both images carry every adapter pack. Which providers an agent serves is
configuration (`ConnectorAgent:Providers`), not a build.

Two kinds of agent exist, and the difference is configuration
(`ConnectorAgent:Class`):

- **pooled** — the operator's fleet, one or more per environment, rendered by
  munni's platform. Stateless between jobs: profiles are wiped, a session
  left open by our own bug is signed out.
- **byo** (bring your own; "household") — one a user runs on their own
  machine, enrolled with a code minted for that user. It serves only that
  user's jobs, keeps browser profiles between jobs, and is the only place a
  `browser_persistent` provider can run.

## Tiers

A provider's manifest declares its runtime:

| Tier | `runtime` | What runs | Where |
| --- | --- | --- | --- |
| T1 | `http` | plain HTTP against the provider's API | inline in the control plane, no agent |
| T2 | `browser_once` | a fresh Chromium per job, thrown away after | pooled agent |
| T3 | `browser_interactive` | a Chromium the human may have to help through | pooled agent, or a household one |
| T4 | `browser_persistent` | one Chromium profile kept between jobs, the provider trusts it | household agent only |

## Who holds which secret

| Custody | Where the session lives between jobs | Providers |
| --- | --- | --- |
| `client` | in a **sealed bundle** the consumer holds (AES-GCM under the control plane's key ring, `sb_v1.<kid>.…`); the control plane keeps nothing | every T1–T3 provider today |
| `agent` | in the household agent's browser profile on the user's own disk; the bundle names the agent and the profile | `asn-persistent` |
| `server` | in a vault on the control plane, for unattended scheduled sync | none yet — slice M4 of the plan |

A **credential bundle** (`cb_v1.…`) is the same seal around the login
inputs, minted on request so a device can re-connect without asking again;
the control plane forgets it once collected, or after 30 days.

Bundles are bound to the provider, the subject and the manifest version they
were sealed for. A bundle presented for another subject, another provider or
a manifest that has since changed does not open, and every such refusal is
the same `session_expired`.

## A job, end to end

1. `POST /v1/{provider}/login` creates a **session** (queued) and a **login
   job**. A T1 job runs inline; a T2+ job waits for an agent with the right
   class, providers, tier and egress to lease it.
2. The adapter drives the provider. When the provider asks something only the
   human can answer — a code, an app approval, a captcha image, a page that
   must be finished by hand — the agent **raises a challenge**; the session
   becomes `awaiting_input`, and the consumer answers it on the session or
   job route. A `live_view` challenge streams the agent's page as JPEG frames
   the consumer relays to the human, whose taps and keystrokes flow back.
3. The job succeeds with the session's material sealed into a bundle the
   consumer collects **once** from the session view; the session is `active`.
4. Later, the consumer exchanges the bundle for a **ticket** (15 minutes) and
   fetches resources with it: `GET /v1/{provider}/{resource}`. A fetch is a
   job too; it answers with the data, or a job handle to follow, or a
   challenge. Results are staged per session and purged on `ack` or after
   a day. A provider that rotates its session hands back a new bundle with
   the page.
5. `DELETE /v1/{provider}/sessions/{id}` disconnects: a best-effort upstream
   logout where the manifest declares one and the caller sent the bundle to
   do it with, then a purge regardless.

The state machines live in `Connector.Kit/Sessions` and `Connector.Kit/Jobs`
and refuse every transition they do not list.

## The sweeper

`ExpiryService` runs every 15 s on the host that runs background work and
closes every deadline: a lease past its TTL fails the job back to the queue,
a challenge past its expiry fails its job, a job abandoned for 30 minutes
expires, tickets and enrollment codes lapse after 15 minutes, staged results
older than a day are purged, uncollected credential bundles after 30 days.

## Pacing

Three separate things, on purpose:

- **Between two requests inside one fetch:** the agent's politeness gate,
  per provider — the manifest's `min_request_gap_ms` on top of the
  operator's floor, and a provider that answers 429/503 is obeyed
  (`Retry-After`, or 30 s).
- **Between two syncs:** the manifest's `min_interval_seconds` (six hours by
  default), enforced by the control plane for calls that declare
  `X-Connector-Trigger: schedule` — answered `rate_limited` with
  `retry_after_seconds`. A person pressing a button (no header, or `user`) is
  never held to it.
- **Concurrency:** one job per session; a pooled agent takes as many as its
  `MaxConcurrency`; a household agent one for the whole machine.

## Security model

| Layer | Mechanism |
| --- | --- |
| Reachability | the control plane publishes no port; munni's platform renders it onto the environment's network (API side) and the agents' network only. The health route is anonymous and unreachable from outside. |
| Authentication, production | a bearer token from the environment's identity provider for the configured audience (`Connector:Auth:Authority`, `Audience`), minted for the munni API by client credentials; optionally a scope every consumer token must carry (`RequiredScope`). No token, wrong issuer, wrong audience, wrong key: 401, and the caller learns nothing else. |
| Authorisation | `/v1/admin/*` (provider pause/retire, canaries, the whole fleet) needs the `AdminScope` (`connector:admin` by default) on top; a known caller without it is 403. Development has no tokens: one shared header (`X-Connector-Key`) is the whole gate. |
| Subjects | every route that names a session, a job, a ticket or an agent requires `X-Connector-Subject` and answers only its owner. The connector never sees a user id, e-mail or name — the consumer hands it an opaque subject. |
| Agents | enrollment codes are minted per subject (a household agent serves only that subject) or for the fleet; per-agent tokens are stored hashed; revocation kills the token and marks the profiles unhealthy; an agent that learns it is revoked wipes its profiles. |
| Catalogue | both sides digest the manifests they registered; an agent whose digest differs is leased nothing and shown as stale. |
| Secrets in flight | bundles and inputs pass through memory; the live-view routes log no HTTP bodies; no bundle over a stream. |
| Secrets at rest | none for client-custody providers; the bundle key ring and the enrollment HMAC key are the environment's, rotated by key id. |

What this does not address, so nobody assumes otherwise: a compromised
consumer holds the machine credentials and can drive any user's *live*
session; a compromised host can read a pooled agent's memory while a job
runs. Live runs, never stored secrets, is the accepted blast radius.

## Where munni comes in

The munni API will be the consumer (slice M1): it holds the machine token,
derives an opaque subject per user and environment, relays the session and
challenge routes to the app, stores the sealed bundles with the user's other
device-held secrets, and schedules unattended syncs with the `schedule`
trigger. Munni's platform renders the control plane, its database and the
pooled agent per environment (slice M2). Until then the platform is complete
on its own terms and tested against its mock providers.
