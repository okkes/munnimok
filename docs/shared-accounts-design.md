# Shared financial accounts — design (feature "B")

Status: **draft for review** — nothing here is built yet.

## The idea in plain language

A bank account's transactions are facts: date, amount, merchant, what
the bank said. Those facts are the same no matter who looks at them, so
they should exist **once**. What people *do* with a transaction —
its category, notes, splits, reimbursements — is an opinion, and
opinions belong to a **space**: the same Albert Heijn payment can be
"Groceries" in your personal space and "Household · shared" in the
space you share with your partner.

So the model splits in two:

- **Raw data** (the bank truth): stored once per financial account, in a
  dedicated *account feed*. Nobody edits it — it only grows, fed by
  GoCardless or file imports.
- **Transformation data** (the opinions): category, transaction type,
  notes, splits, reimbursements, review flag, counter-account link.
  Stored per space, one overlay row per (space, transaction).

You then **attach** an account to any space you like. Members of that
space can read the account's transactions from the attachment's
history-start date onward (the space's default start date prefills
this); owners and contributors can edit the overlay, readers cannot.
Detaching removes access; the raw data is untouched.

When the person who connected an automated (PSD2) account **leaves a
shared space**, the attachment becomes **archived**: the history that
was already shared stays readable, but no new transactions flow in,
and the space shows a "reconnect via your bank" prompt. Because import
ids are derived from the IBAN, any member who reconnects the same bank
account continues the exact same feed — no duplicates, no gap.

Manual (cash/typed) accounts are explicitly **out of scope** here; they
keep today's behavior until we design their mechanics together.

## How it maps onto the sync system

Nothing about the sync engine changes conceptually — feeds are just
one more kind of space:

- An **account feed is a sync space** (deterministic id,
  `uuidv5("feed:" + IBAN)` for bank accounts). It contains the account
  row and the raw transaction rows. Same oplog, same HLC/LWW, same
  pull cursors.
- **Write access to a feed**: only the account's owner and the server
  (GoCardless ingest). Everyone else is effectively a reader.
- **Read access** is *derived*: you may pull a feed if you are a member
  of any space it is attached to (or its owner). The server checks this
  by joining a new `SpaceAccountAttachment` table — no membership rows
  are copied around, so nothing can drift.
- **Attachment** is server-authoritative (like invites/membership):
  `POST /spaces/{id}/accounts` records it and is mirrored into the
  space as a synced `accountLink` row `{accountId, feedSpaceId,
  attachedBy, historyFrom, archived}` so offline devices render it.
- **The overlay** is a new synced entity `txMeta` living in each
  attached space: id = `uuidv5("meta:" + spaceId + ":" + rawTxId)`,
  fields = catId, txType, notes, splits, reimbursements, needsReview,
  linkedAccountId. Deterministic ids mean two members creating the
  overlay for the same transaction concurrently converge by LWW.
- **Auto-categorization moves client-side**: the GoCardless ingest
  writes raw facts only. Each space's devices create the default
  overlay (keyword prediction, already ported to the client) the first
  time they see a raw transaction without one. The server stays
  domain-agnostic.
- **SSE / discovery**: `/me/spaces` and the event stream include feeds
  reachable through attachments, so real-time sync just works.
- **Owner leaves**: the member-removal handler archives their
  attachments in that space (server) — feed access for the space ends
  for *new* data by freezing the attachment's `archivedAtSeq` cursor;
  history up to that point stays pullable.

## What the user sees

1. **Accounts screen (per space)**: attached accounts with balances,
   an *Attach account* action listing your feeds not yet attached
   (with a history-from date, prefilled from the space's default
   history start), a *Detach* action, and an **Archived** badge with a
   "Reconnect via your bank" button where applicable.
2. **Transactions/detail**: unchanged visually — the app joins raw +
   overlay transparently. Edits write the overlay; readers see
   everything disabled (roles already enforced server-side).
3. **Bank connect / CAMT import**: unchanged flows; they now create or
   extend feeds and auto-attach them to the space you started from.

## Migration (the risky part, done carefully)

Today raw+overlay live merged inside the owning space. Migration is a
one-time, idempotent, client-side job on the account owner's device
(all through the normal Repo → ops → sync path, so other devices just
receive it):

1. For each existing bank account: create its feed space
   (deterministic id), write the account row + raw halves of its
   transactions there.
2. Write the overlay rows (`txMeta`) with the transformation halves
   into the original space, attach the feed to that space
   (historyFrom = oldest transaction).
3. Tombstone the old merged rows, set a per-account migration marker.
4. Reads support both shapes during rollout (old merged rows win until
   their account is migrated), so a mid-migration device never shows a
   gap; deterministic ids make replays harmless.
5. Staging first with a copy of production data; production only after
   we've verified counts/balances match pre- and post-migration.

## Build order

- **P1** — schema + domain: `txMeta`, `accountLink`, join layer,
  client prediction-on-first-sight; unit tests incl. LWW convergence
  of concurrent overlay creation.
- **P2** — server: attachment table + endpoints, derived feed access in
  push/pull/events/discovery, archive-on-leave; integration tests.
- **P3** — migration job + dual-read compatibility; verified on staging.
- **P4** — UI: attach/detach, archived + reconnect, history-from.
- **P5** — e2e: two users attach + categorize the same feed
  differently; owner leaves → archive; second member reconnects → same
  feed continues without duplicates.

## Open questions before building

1. **Archived history**: when the owner leaves, the already-shared
   history stays visible (read-only) in the space — confirm that's the
   intent, rather than the account disappearing entirely.
2. **Personal spaces**: should your own accounts be *explicitly*
   attached to your personal space too (one uniform mechanism — my
   preference, migration auto-attaches them), or implicitly "just
   there" like today?
3. **History-from**: per attachment, prefilled from the space's default
   history start, editable at attach time — enough, or do you want to
   change it after attaching as well?
4. **Balances**: the account balance is raw (bank truth) and shown the
   same in every space — agreed? (Per-space "balance since
   history-from" could be a later add.)
5. **Reimbursements across accounts** stay within one space's overlay
   (they reference other transactions by id) — a reimbursement linked
   in your personal space won't appear in the shared space. Confirm.
