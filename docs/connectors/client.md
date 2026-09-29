# The app's side

The web app (and the native shells around it) never talks to the
connector control plane. It talks to the munni API's relay
([relay.md](relay.md)) and renders what the catalogue declares. This page
is written from `apps/web/src/features/connectors` and
`apps/web/src/application/connections.ts` (slice M3 of
docs/connector-integration-plan.md §10; §14 records where it departs).

## What a connection is, on a device

| Row | Where | Synced | Holds |
| --- | --- | --- | --- |
| `storeConn` | the owner's store feed (`feed:STORES:{sub}`) | yes — every device of the owner renders it | the connection id, the provider id, the display name, the icon, a hash of the party account, `status: ok \| expired` |
| `storeConnLink` | each space the connection is used in | yes — members see it | the connection id plus a name/icon snapshot, so a member renders it without the owner's feed |
| `connectorConn` | the device only (Dexie `connectorConns`, SQLCipher `connector_conn`) | never | the provider, the relay session id, the last state the relay spoke, the last refusal, `lastSyncAt`, and — on the phone — the bundle |

The connection id is the client's: minted once (a uuid), reused on every
re-login, and the key of every receipt the relay files
(`rcpt:{provider}:{connectionId}:{external id}`), so a sign-in never
duplicates a receipt.

**Custody** (`bundles.ts`): a bundle in the `connectorConn` row means
device custody, wherever the row was written. On the web the bundle lives
in `sessionStorage` and the row carries none — it dies with the tab, and
the card reads *sign in to sync on this device* next time. The bundle is
never synced through spaces and never exported; the E2EE device sync
([architecture.md §7b](../architecture.md)) ferries it as ciphertext
between the owner's devices.

## The hub (`ConnectionsScreen`)

Settings → Connections, route `/connections`. One card per connection:
the party's picture (the user's own pick, else the brand asset the
catalogue's `logoRef` names, else the kind's icon), the party's health
when it is not `healthy`, the state line, the spaces the connection is
used in, one primary action, and the manage door.

| The device says | The line | The action |
| --- | --- | --- |
| no row on this device, `status: ok` | connected on another device | — |
| no row, `status: expired` | reconnect needed | Reconnect |
| `active` with a bundle | synced *when* · not synced yet | Sync now |
| `active`, no bundle (the tab is gone) | sign in to sync on this device | Sign in |
| `needs_reauth` · `expired` · `failed` · `disabled` | reconnect needed | Reconnect |
| `blocked` | blocked by the party | — |
| `awaiting_input` | the party has a question | Sync now (answers it) |
| the last refusal was `rate_limited` | the party asked for a pause | Sync now |

The catalogue sheet lists what the relay serves (`GET /connectors/providers`,
cached in the identity's meta store with its ETag): shops for now, by name,
searchable; *needs your own computer* for `agent.class: byo`, *use the
munni app* for `webSupport: none` on the web, *having trouble* / *paused*
from the party's status, retired parties hidden. Demo and offline
identities see their connections and the doors, never a network call.

## The connect flow (`ConnectFlowSheet`)

`manifestForm.ts` turns the manifest into the form: the non-secret
`config` fields as a leading *Settings* step, then the manifest's own
steps with their fields (type, required, pattern, autofill), validation
per step, and the split into the login body's `inputs` (secrets
verbatim) and `config`. A remote-browser party has no form at all.

`POST /connectors/{provider}/login` carries the connection id, the
fields, the provider's kept credential store when signing in again
(`credentialBundle`), and an idempotency key per attempt. The answer is
either settled (200, the bundle attached) or a run to follow. A run is
followed through the `{ kind: "connector" }` frames the sync engine
republishes in-process (`events.ts`) with a poll behind them; every
frame or tick reads the view afresh, because the bundle is handed over
exactly once and never rides a frame.

Every question the party asks is rendered by its typed kind
(`ChallengeCard`):

| Kind | The card | The answer |
| --- | --- | --- |
| `mfa_code` | a code field, the delivery (sms · authenticator · email · app), the countdown | the code |
| `code_display` | the code to enter at the party | "I entered it" |
| `qr_display` | the picture, fetched through the relay | "I approved it" |
| `app_approval` | a waiting card | "I approved it" |
| `image`, text | the picture and a field | the text |
| `image`, taps | the picture; every tap marks a point | `tap.v1:x,y;…;submit`, or `tap.v1:` for "none match" |
| `select_option` | the options | the option's value |
| `redirect` | *Open the party's page* — iOS runs it in the auth session with the party's callback scheme and brings the return address back; Android and the web open it and take a paste | the return address |
| `live_view` | the party's own page streamed as frames (`LiveView`): taps, moves and scrolls relayed as fractions, a text field, Enter and Backspace | — (the agent finishes when the page does) |

A settled login is adopted (`useConnectionOps().adopt`): the device row
and custody first, then the synced `storeConn` row (named after the
party, numbered when the name exists), the `storeConnLink` for the
active space, an activity line, and the first sync. The hub then asks
for a display name and warns when the party account was connected
before (the hash of `providerAccount.externalId`).

## Sync (`connectorSync.ts`)

`POST /connectors/{provider}/sync { connectionId, bundle, since }` with
`since` = the day before the last sync (the relay widens by the party's
settlement lag). A 200 keeps the rotated bundle when there is one,
marks the row `active` with `lastSyncAt`, pulls the feeds
(`engine.syncAll()`) and matches receipts into every included space. A
202 is a job: followed through frames and polls, a rotated bundle kept
from any view that shows it, a question answered through the caller
when a human is there (*Sync now* in the hub opens the question in a
sheet) and left for the hub otherwise (`asking`), then collected with
the bundle.

A refusal is spoken in the connector's envelope: `session_expired`,
`invalid_credentials`, `mfa_failed`, `consent_expired` and
`unsupported_resource` drop the bundle and mark `needs_reauth` (the card
reads *reconnect*); `blocked_by_provider` marks `blocked`;
`rate_limited` asks for patience with the relay's `retryAfterSeconds`;
anything else is shown with its copy and left to retry.

Triggers: *Sync now*; app open (after adopting fresher bundles from the
E2EE sync, connections not synced for twelve hours); every clean sync
cycle of the engine (fresh bank transactions just landed — connections
not synced for fifteen minutes). Only rows that are `active` with a
bundle in custody are tried.

## Matching (`application/receiptMatching.ts`)

The relay files receipts into the owner's store feed; the matcher runs
per included space over the rows the pull landed. A rung-1 single on a
transaction still to review attaches itself (`receiptLink` with `txId`,
`auto: 1`). A single whose transaction is already reviewed becomes a
**proposal** — the link carries `proposedTxId` and no `txId` — listed
under *Matches to check* on the Receipts screen and shown on the
transaction itself. Yes attaches it; no adds the transaction to
`rejectedTxIds`, and the receipt is re-evaluated against everything but
those. A receipt's invoices (`documents[]`) ride the link snapshot like
a photo's image, so a member opens them without the owner's feed.

## Banks (M4)

A bank connection is the same rows as a shop's, minus the receipts
machinery: `adopt` writes the synced connection row with `kind: 'bank'`
and the device row, and no `storeConnLink` — a bank's accounts attach one
by one, like every other feed account. The relay's ingest files the
party's accounts into the IBAN's feed (`feed:{iban}`, co-owned when
someone else connected it first) or a personal `CONN:{provider}:{id}`
feed for a card without an IBAN, with `source: 'connector'`, the party as
`provider`, `lastSyncedAt`, the balance and its date, and the
transactions behind them; the feed is listed by `/me/spaces` on the next
pull, so a sync (`engine.syncAll()` after the relay answered) lands the
rows without a client change.

The hub's bank card lists those accounts (`useConnectorAccounts`: every
`source: 'connector'` account with the spaces it is attached to). An
account not attached to the active space offers *Attach to {space}*: the
door sets the space attach intent (#310) and opens the space's accounts
screen on the final step, the account picked, the type and the history
start to choose. Nothing joins a space by itself. *Sync now* speaks
transactions and accounts for a bank.

No bank adapter asks the app which accounts to fetch (`select_option` is
unused by the packs; ASN confirms all accounts inside its own page), so
there is no pick at connect time. ING signs in with a form and the app's
approval (`app_approval`), ASN with its own page streamed (`live_view`,
the QR rotates in the frames), the mock banks with a form; a bank that
keeps its sign-in on the user's own computer (`asn-persistent`) is marked
"needs your own computer" in the catalogue and refused with the
connector's `agent_unavailable` until the household agent exists (M5).

On the accounts screens a connector-fed row is treated like an
open-banking one (`fetchesItself()`): the synced-empty fact and the
reconnect hint apply, the stale-export warning does not, and the source
label reads "Fetched by munni from {party}". Beside a statement import
of the same IBAN the bank keeps its own `acct:{iban}:bank` row until the
explicit merge — the ingest follows #311 r4 exactly as open banking does.

## Removing a connection

The party is told first (`DELETE /connectors/{provider}/sessions/{id}`
with the bundle when this device holds it; the relay drops its binding
either way), then the connection's unattached receipts in the store
feed, the `storeConn` row and every `storeConnLink` are tombstoned, the
device row and custody are forgotten, and the E2EE ciphertext is
removed. Attached receipts stay with their transactions (they are
snapshots).

## What the app never does

- Send a subject, a user id or a name to the connector (the relay mints
  the subject).
- Store a password: the form's secrets go into one login request and
  are gone; the party's own page is streamed, never proxied.
- Put a bundle in a synced row, an export, a log or a frame.
- Enumerate parties itself: the catalogue is the relay's; the app only
  maps `logoRef` to the brand assets it ships and spells an id when it
  has nothing better.
- Answer a party's question on the user's behalf.

## Tests

`features/connectors/*.test.ts(x)`: the form functions; one sync pass in
every outcome (settled, rotated, refused, a job followed and collected, a
question answered or left); the frame bus; the hub against a mocked
relay (the catalogue, the form, a code challenge, a refusal with and
without a retry, *Sync now* speaking new receipts, a pause and a dead
session, reconnect and removal); and `copyCoverage.test.ts`, which walks
`server/src/connectors` for every `connect.*` key and every wire enum
and fails on a missing EN, NL or TR entry. `application/receiptMatching.test.ts`
covers attaching, proposing, accepting, rejecting and double-booking;
`application/connectionSync.test.ts` the E2EE device sync with real
crypto.
