# Connectors

The connector platform pulls a person's own data out of the places that hold
it — shops, banks without an open-banking feed, the credit and student-debt
registries — with that person's own credentials, on their behalf, into munni.
It lives in this repository under `server/src/connectors` (ported from the
`munniscrape` repository in #367) and ships as two images: one control plane
and one agent.

This folder is the documentation of what the code does. It is written from
the code and kept in step with it; a claim here that the code does not make
is a bug in this folder.

| Document | What it answers |
| --- | --- |
| [architecture.md](architecture.md) | The planes, the tiers, who holds which secret, how a job runs, what is kept and for how long, the security model |
| [contract.md](contract.md) | The HTTP contract a consumer codes against: headers, routes, the error table, challenges, the agent protocol |
| [adapters.md](adapters.md) | Every provider the packs ship, what each can and cannot do, and how to add one |
| [relay.md](relay.md) | The munni API's side (slice M1): configuration, the routes the app calls, subjects and bindings, the event bridge, how records land in the feeds, the operator's routes |
| [client.md](client.md) | The app's side (slices M3–M4): the Connections hub, the connect flow and its challenges, custody of the bundle, sync and matching, banks and the attach step, the E2EE device sync, what the app never does |
| [deploy.md](deploy.md) | Running it: the local loop, the images, the household agent, what munni's platform renders |
| [../connector-integration-plan.md](../connector-integration-plan.md) | The plan that brought it here and the slices that follow (relay, platform, hub, banks, registries, admin) |
| [research/](research/) | Provider research notes |

## The non-negotiables

- **Nothing is stored that the user did not ask us to keep.** A session's
  tokens travel in a sealed bundle the consumer holds; the control plane keeps
  no provider credential at rest for client-custody providers. Staged results
  are purged on acknowledgement or after a day.
- **Every user-facing thing is owned.** Sessions, jobs, tickets and household
  agents belong to a subject, and the connector answers only that subject —
  somebody else gets the answer a thing that does not exist gets.
- **Human-plausible cadence, never a firehose.** Requests inside a fetch are
  paced per provider; scheduled syncs are held to the provider's interval; a
  person pressing a button is never throttled by it.
- **Adding a provider never touches the API.** One generic handler per shape;
  a provider is a manifest plus an adapter, registered in one line.
- **The agent only ever calls out.** Nothing connects to an agent; a
  household agent behind NAT on a residential line needs no redesign.
- **Both sides run the same adapter code.** An agent whose adapter catalogue
  differs from the control plane's is enrolled, alive and leased nothing.

## Layout

```
server/src/connectors/
  Connector.Kit/                the shared kit: manifests, challenges, errors, sessions, jobs,
                                sealed bundles, normalisation records, the agent protocol
  Connector.Kit.Hosting/        the control plane library: /v1, /agent/v1, EF Core, sweeps
  Connector.Kit.Agent/          the agent library: enrollment, leasing, Playwright, live view
  BankConnector.Adapters/       ing-nl, asn, asn-persistent + the mock banks
  ShopConnector.Adapters/       ah, lidl, jumbo, bol, coolblue, amazon-nl, mediamarkt-nl + mocks
  RegistryConnector.Adapters/   bkr, duo + mocks
  Connector.Api/                the control plane host: every pack, one image (munni-connector-api)
  Connector.Agent/              the agent host: every pack, one image (munni-connector-agent)
server/tests/connectors/        one test project per library and pack, plus the control plane's
deploy/connectors/              household-agent.yml — the compose a household runs
docs/connectors/                this folder
```

Munni's platform (`infra/`) renders the control plane and the pooled agent
into each environment's stack; the munni API is the only consumer. Neither
is wired yet — that is slice M1/M2 of the plan.

## Working on it

```
dotnet build server/Munni.slnx
dotnet test server/Munni.slnx --collect:"XPlat Code Coverage" --results-directory coverage
node server/tests/coverage-gate.mjs coverage
```

The connector assemblies are gated at 85 % line coverage each, on the union
of every report of the run (the kit is exercised by six suites), by
`server/tests/coverage-gate.mjs`; CI runs it after the tests. The agent's
live-view and redaction tests drive a real headless Chromium — install it
once with the Playwright script the test build drops next to the test
assembly (`playwright.ps1 install chromium`).

A local control plane: `dotnet run --project server/src/connectors/Connector.Api`
with `ASPNETCORE_ENVIRONMENT=Development` — Sqlite, no authority, an
ephemeral bundle key ring, the mock providers registered. Its reference is
served at `/scalar`, the document at `/openapi/v1.json`.
