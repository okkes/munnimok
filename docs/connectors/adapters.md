# Adapters

An adapter is an `IProviderAdapter` plus a `ProviderManifest`, registered by
its pack (`BankAdapters.All`, `ShopAdapters.All`, `RegistryAdapters.All`)
into both hosts. The manifest is the whole contract a consumer sees — the
login form it renders, the resources it may ask for, the tier and custody
that decide where the job runs and where the session lives — and the
adapter is the only code that knows the provider.

The facts below are read from the manifests in the packs. "Unattended" is
whether a stored credential can pull data with nobody there; "headed login"
is whether connecting can hit a wall only somebody at the agent's own browser
can pass. False does not mean nobody is needed — it means whoever is needed
can be reached by relay or by a live view.

## Shops (`ShopConnector.Adapters`)

| Provider | Id | Tier | Unattended | Headed login | Custody | Returns |
| --- | --- | --- | --- | --- | --- | --- |
| Albert Heijn | `ah` | `browser_once` | yes | no | client | receipts |
| Lidl Plus | `lidl` | `browser_interactive` | yes | no | client | receipts |
| Jumbo | `jumbo` | `browser_interactive` | no | no — a walled login is streamed | client | receipts |
| bol.com | `bol` | `browser_interactive` | no | yes | client | receipts |
| Coolblue | `coolblue` | `browser_once` | no | yes | client | receipts |
| Amazon.nl | `amazon-nl` | `browser_interactive`, desktop browser | no | yes | client | receipts |
| MediaMarkt | `mediamarkt-nl` | `browser_interactive`, desktop browser | no | yes | client | receipts, with the invoice PDF |
| Mock ×6 | `mock-store-*` | `http` / `browser_persistent` | yes | no | client / agent | receipts |

Every shop requires NL residential egress from a pooled agent. None declares
an upstream logout that the control plane can reach: custody is `client`, so
the token is in the bundle on the device.

Jumbo's login is a hybrid and both credentials are optional; read the pack's
README before enabling it — Auth0 raises a Turnstile on a risk score, the
adapter checks for the wall before typing the password, and a walled day
streams the page to the account holder. Jumbo's GraphQL protocol is not
settled until a live capture says so.

## Banks (`BankConnector.Adapters`)

| Provider | Id | Tier | Unattended | Headed login | Custody | Returns |
| --- | --- | --- | --- | --- | --- | --- |
| ING | `ing-nl` | `browser_interactive` | no | no | client | accounts, transactions |
| ASN Bank | `asn` | `browser_interactive` | no | no | client | accounts, transactions |
| ASN Bank, own machine | `asn-persistent` | `browser_persistent` | yes | — | agent | accounts, transactions |
| GoCardless | `gocardless` | `http` (inline) | yes | — | server | accounts, transactions |
| Enable Banking | `enablebanking` | `http` (inline) | yes | — | server | accounts, transactions |
| Mock ×5 | `mock-bank-*` | `http` … `browser_persistent` | — | — | client / agent | accounts, transactions |

The two aggregators (#414) are the open-banking door: the person picks the
bank from the party's own list (a `lookup` field the control plane serves
from the aggregator, logos vendored), consents at the bank through a
`redirect` challenge the consumer's return page answers with the landing URL,
and the aggregator hands the accounts over on HTTPS ever after — no browser,
no agent. The session is the consent: its id at the aggregator and the
accounts it reaches (their details learned once), never a credential; the
operator's key is `BankAdapters:GoCardless:*` / `BankAdapters:EnableBanking:*`
configuration, and a party without it is absent from the catalogue. Server
custody lets the consumer's scheduler fetch nightly at
`preferred_fetch_hour_local` in the bank's zone. Transaction identities are
the ones the api's own integration keyed on (`transactionId ??
internalTransactionId`, `pending:` for a pending row, `eb:` + a digest where
Enable Banking gives no reference), so a reconnected bank continues its
history. The account record names its `institution` — the lookup's own
value — so a consumer shows the same logo on the account row. GoCardless
also answers the operator's inventory (every consent on the aggregator
account, with the environment that made it) and reports its per-account
daily budget as the party's quota.

`asn-persistent` is the household-agent form of ASN: the sign-in the user
does once stays in a browser profile on their own machine, and scheduled
fetches run from there. `AsnDiscoveryAdapter` (`asn-discovery`) is kept in
the pack unregistered: it is the instrument that mapped ASN's screens (it
streams the page and records what each screen is made of) and de Volksbank
serves SNS, RegioBank and BLG Wonen from the same pages — register it to map
a screen, then take it back out.

## Registries (`RegistryConnector.Adapters`)

| Provider | Id | Tier | Unattended | Headed login | Custody | Returns |
| --- | --- | --- | --- | --- | --- | --- |
| BKR | `bkr` | `browser_interactive` | no | no | client | credit registrations |
| DUO | `duo` | `browser_interactive` | no | no (DigiD; a household agent is expected) | client | student debt |
| Mock ×2 | `mock-registry-*` | `http` | — | — | client | credit registrations |

## Verification markers

Every provider fact an adapter uses — a client id, a selector, a money unit,
a portal path — is marked in its options class as OBSERVED (seen in a live
capture on a date) or not. The unconfirmed ones are the ones a deploy may
have to correct: each is reachable from the pack's options section
(`BankAdapters`, `ShopAdapters`, `RegistryAdapters` in both hosts'
configuration), so a provider that moves is a configuration edit rather than
a release. The two hosts must carry the same values; the catalogue digest
(architecture: security) refuses an agent that does not.

Fixtures — recorded pages and payloads — live beside the adapters and are
embedded in the pack; a parse test needs no network, and a fixture test
that fails is a provider that changed shape.

## Adding a provider

1. Write the manifest: id, kind, runtime, custody, whether it fetches
   unattended, the auth spec (steps and fields, which are secret, the login
   origins), the resources it offers with their record shape and typical
   duration, its limits (`min_interval_seconds`, `min_request_gap_ms`), its
   egress requirement, whether it declares a logout.
2. Write the adapter: `LoginAsync` (drive the sign-in; raise challenges
   through `ctx.AskAsync`; return the session material), `FetchAsync` (return
   normalised records for a resource request), `LogoutAsync`.
3. Write the fixture tests in the pack's test project: the parser against
   recorded pages, the manifest through `ManifestValidator`, the adapter
   against a `PageShape` stub or a mock page.
4. Register it in the pack's `All`. Both images pick it up; the catalogue,
   the OpenAPI document and the consumer's login form follow from the
   manifest without another change.

A mock provider is an adapter like any other, kept in the pack so the
control plane's own tests and a local run have something to drive. Every
host registers the mocks today, production included; the platform slice
(M2) gives them a switch.
