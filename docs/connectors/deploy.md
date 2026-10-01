# Deploying

## The images

Both are built by `.github/workflows/release-images.yml` on every push to
`dev` (channel `dev`) and `master` (channel `latest`), tagged
`<channel>` and `<channel>-<build>`:

| Image | Dockerfile | Contents |
| --- | --- | --- |
| `ghcr.io/okkes/munni-connector-api` (amd64, arm64) | `server/src/connectors/Connector.Api/Dockerfile` | the control plane with every adapter pack, on the ASP.NET runtime, port 8080 |
| `ghcr.io/okkes/munni-connector-agent` (amd64) | `server/src/connectors/Connector.Agent/Dockerfile` | the agent with every adapter pack, on the Playwright image (Chromium + Xvfb), entrypoint `agent-entrypoint.sh` |

## Configuring the control plane

`appsettings.json` is production-shaped: a container that starts with no
configuration refuses to boot rather than come up holding credentials under
a key that dies with the process. Everything secret comes from the
environment as `Connector__<Section>__<Key>`:

| Setting | Meaning |
| --- | --- |
| `Connector:Mode` | `Production` (default in the image) or `Development` |
| `Connector:Database:Provider`, `ConnectionString` | `Postgres` in production (Sqlite is refused) |
| `Connector:Auth:Authority`, `Audience` | the identity provider that mints the consumer's machine token and the audience it must carry; both required in production |
| `Connector:Auth:MetadataAddress`, `RequireHttpsMetadata` | where the issuer's discovery document is fetched when that is not the authority itself — a control plane on a private compose network reaches its Logto by service name over plain http while the issuer stays the browser-facing url; default: the authority, over https |
| `Connector:Auth:RequiredScope` | a scope every consumer token must carry; optional |
| `Connector:Auth:AdminScope` | the scope that opens `/v1/admin/*`; `connector:admin` by default |
| `Connector:Auth:SharedSecret` | development only: the value expected in `X-Connector-Key` |
| `Connector:Bundle:CurrentKid`, `Connector:Bundle:Keys:<kid>` | the bundle seal key ring (32 bytes, base64); rotate by adding a key and moving `CurrentKid` |
| `Connector:EnrollmentHmacKey` | signs enrollment codes |
| `Connector:FleetSubjects` | the subjects whose enrollment codes enroll pooled (fleet) agents |
| `Connector:FleetEnrollmentCode` | the operator's own fleet enrolls with this code, in production too: a generated per-platform secret the platform renders into the pooled agent and into every control plane of the platform, seeded under the subject `fleet` and re-armed on every start so an agent with a wiped state file comes back |
| `Connector:DevEnrollmentCode` | development only: a fixed reusable code for a local agent |
| `Connector:MaxQueuedJobs` | back-pressure: a login is refused when the queue is this deep |
| `Connector:Timeouts:*` | ticket 900 s, lease 120 s, heartbeat 30 s, agent poll 30 s, login wait 3 s, fetch wait 25 s, job 300 s, abandoned job 1800 s, credential bundle 30 days, politeness 800 ms, challenge grace 300 s, live frame poll 5 s, result retention 1 day, enrollment code 900 s, sweeps 15 s / 60 s |
| `BankAdapters`, `ShopAdapters`, `RegistryAdapters` | the packs' provider facts (see adapters.md) — keep in step with the agents |
| `BankAdapters:GoCardless:SecretId`, `BankAdapters:GoCardless:SecretKey`, `BankAdapters:EnableBanking:ApplicationId`, `BankAdapters:EnableBanking:PrivateKeyPem` | the operator's aggregator accounts (#414): the party exists when its keys do; the platform renders them from the same four secrets the api once took (`GOCARDLESS_*`, `ENABLEBANKING_*`) and never hands them to an agent — a manifest does not depend on them, so the catalogue digest stays equal on both sides |

The host runs the background work (expiry sweep, canaries, inline T1 jobs)
by default; a second replica would run them twice, and the ticket store is
in memory — one replica per environment.

## Configuring an agent

`ConnectorAgent:*` (`ConnectorAgent__<Key>` in the environment):

| Setting | Meaning |
| --- | --- |
| `Connections:<n>:Name`, `ControlPlaneBaseUrl`, `EnrollmentCode`, `ControlPlaneCaPath` | one entry per control plane this agent serves (the single-connection spelling `ControlPlaneBaseUrl` + `EnrollmentCode` at the top level means exactly one) |
| `Class` | `pooled` or `byo` |
| `Egress:Country`, `Egress:Kind` | where this agent's traffic leaves from (`residential` or `any`); must be honest — a datacenter claiming residential earns the jobs it will fail |
| `Providers` | the providers to serve; empty means every one it carries |
| `MaxConcurrency` | jobs at once for the whole machine (a household agent: 1) |
| `Headless` | true for a rack, false under Xvfb for a household agent |
| `AgentName`, `StateFilePath`, `ProfileRootDirectory`, `WorkRootDirectory` | identity and disk |
| `BrowserDevice`, `BrowserChannel`, `BrowserLocale`, `BrowserTimezoneId`, `KeptSessionLifetime` | the browser it presents |
| `BankAdapters`, `ShopAdapters`, `RegistryAdapters` | the same provider facts as the control plane's |

The agent enrolls once with the code, keeps its token in the state file
(owner-only on Unix), and resumes that enrollment on every later start;
a control plane that revokes it makes it wipe its profiles and retire that
connection.

## The household agent

`deploy/connectors/household-agent.yml` is the compose a user runs on their
own machine: the agent image, one connection, headed under Xvfb, one job at
a time, two volumes (state, profiles), a 45 s stop grace so a job can finish
its sign-out:

```
CONNECTOR_URL=https://…/connector ENROLLMENT_CODE=AGNT-…  docker compose -f household-agent.yml up -d
```

`CONNECTOR_URL` is the address the app shows for the environment;
`ENROLLMENT_CODE` is minted for the user through the consumer
(`POST /v1/agents/enrollment`) and is good for 15 minutes, once.
`AGENT_IMAGE`, `AGENT_EGRESS_COUNTRY` and `AGENT_EGRESS_KIND` override the
defaults (`…:latest`, `NL`, `residential`).

## The local loop

```
ASPNETCORE_ENVIRONMENT=Development dotnet run --project server/src/connectors/Connector.Api
```

Sqlite in the project directory, no authority, an ephemeral bundle key ring
(a restart invalidates every bundle — right locally, refused in production),
the mock providers registered, the reference at `/scalar`. Set
`Connector:DevEnrollmentCode` to enroll a local agent:

```
ConnectorAgent__ControlPlaneBaseUrl=http://localhost:5000/ ConnectorAgent__EnrollmentCode=AGNT-DEV… \
  dotnet run --project server/src/connectors/Connector.Agent
```

## What munni's platform renders (slice M2 of the plan)

`infra/modules/render.mjs`, from the committed config (`infra/platforms/`,
see its README): an environment with `features.connectors` gets

- **the control plane** `connector-<env>` (image `munni-connector-api:<channel>`)
  beside its api: `Connector:Mode=Production`, its own database `connector`
  on the environment's Postgres (created by `initdb`), the environment's
  Logto as issuer (`Connector:Auth:Authority`) and its own public address as
  audience — on this computer the discovery document is fetched in-network
  over http (`MetadataAddress`, `RequireHttpsMetadata=false`) while the
  issuer stays the browser-facing url; the seal key ring (`k1`), the
  enrollment HMAC key and the platform's fleet enrollment code from the
  secrets manifest; a `wget` health check on `/v1/health`;
- **a published host** `munni-<env>-<platform>-connector` on port
  8387 + 100·slot (DSM reverse-proxy rule on the NAS, the family Caddy in
  LAN mode) — the address household agents dial from outside. The control
  plane is reachable, and answers nobody without the machine token or an
  agent's own token; the health route alone is anonymous and carries no
  data. This is the one departure from the plan's "publishes no port":
  household agents have to reach it from home, and a token-protected host is
  the honest way to do that;
- **the api's relay settings** `Connectors:*` — the in-network base url,
  the audience, the subject salt, the machine app the Logto module writes
  back (until then the relay stays off and the api says why), and the
  public address as `AgentPublicUrl`.

The platform's shared stack gets **the pooled browser agent**
`connector-agent` (image `munni-connector-agent:<channel>`) when the
platform ticks `browserAgent`: every provider pack, headed under Xvfb,
`Class=pooled`, the platform's `agentEgress` claim, one connection per
environment that runs connectors (`http://connector-<env>:8080/` over the
shared network) enrolled with `CONNECTOR_FLEET_CODE` — the standing code
every control plane of the platform seeds under the subject `fleet`
(`Connector:FleetEnrollmentCode`). It is rendered only when at least one
environment runs connectors, because an agent with nowhere to call
refuses to start. It publishes nothing and dials only out.

**The Logto module** (`ensureConnectorAccess`) makes the control plane an
API resource of the environment's Logto (indicator = its public address)
carrying the scope `connector:admin`, a machine role granting it, and the
api's machine application holding the role; the pair is written back as
`CONNECTOR_M2M_APP_ID/SECRET`. The secret is the module's own application
secret on that app, named `munni bootstrap` — Logto's application endpoints
carry none (found live 2026-10-01: the write-back had stored the string
"undefined" and the api's token mint answered 401, which the relay reports
as 503 `provider_unavailable`); it is read back on every bootstrap and
minted once, so a run without a deploy never desyncs the running api from
Logto, and a write-back refuses a credential without a value. The api
mints client credentials for that resource and the scope comes along, so
one token opens the consumer routes and the operator's. An environment's cleanup removes the three with the
api's own app.

**Secrets** (`infra/secrets.manifest.json`): per environment, generated —
`CONNECTOR_SEAL_KEY_K1` (32 bytes, standard base64), `CONNECTOR_ENROLLMENT_HMAC`,
`CONNECTOR_SUBJECT_SALT`; module-owned — `CONNECTOR_M2M_APP_ID/SECRET`;
per platform, generated — `CONNECTOR_FLEET_CODE` (`AGNT-XXXX-XXXX`),
mirrored into every environment. `deploy-nas.yml` passes each by name.

**The wizard**: the environment form's *Connectors* tick, the platform's
*pooled browser agent* tick with its line (residential / datacenter), and a
*Connectors* tab in the environment workspace with the facts above, the
household compose line and a liveness check of the control plane through
the helper. Nothing here asks for an account: every credential is minted.
The party states, the fleet and the canaries are the admin portal's
(slice M6).
