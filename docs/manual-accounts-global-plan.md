# Account tiers — fully linked, semi linked, space-scoped manual

Status: **DESIGN v2 — user redirection** (2026-07-22). The earlier
"manual accounts go global" idea is dropped. User ruling: there are
THREE kinds of financial accounts, and only the last one accepts
manually added transactions.

## The three tiers

| Tier | Source | Lives | Attach model | Manual tx |
|---|---|---|---|---|
| **Fully linked** | Open banking (GoCardless, EnableBanking) — data arrives on its own | Feed space (global) | Per-space attach with start date | **Never** — the bank is the single source of truth |
| **Semi linked** | Bank export uploads: CAMT.053 today, ING/CSV dumps next | Feed space (global) | Same per-space attach | **Never** — the next upload is the source of truth; hand-typed rows would duplicate or contradict it |
| **Space-scoped manual** | Typed in by hand (cash, savings jar, informal loans) | Inside ONE space, like today | None — it exists only where it was created | **Yes** — the only tier where transactions are hand-entered, and balance updates live with them |

Why the hard no on manual tx for linked tiers: a hand-typed row on a
bank-fed account WILL collide with the imported truth (dedupe can't
tell a manual entry from a slow booking), and reconciliation errors
are exactly what munni exists to avoid. If something is missing from
a bank feed, the fix is an upload (semi) or waiting for the feed
(full) — or tracking it in a manual account.

## What this changes (and doesn't)

The architecture already matches: full + semi accounts are feed-space
accounts with `accountLink` attachment; manual accounts are space
rows. No migration, no global manual feeds, no ownership-transfer
machinery. The work is ENFORCEMENT + CLARITY:

- **Enforcement**: manual add/edit of transactions is already blocked
  for `gocardless` accounts — extend the same block to `camt053` (and
  any future import source). One rule: `source !== 'manual'` ⇒ no
  manual tx, client-side (form hides the account) and server-side
  (validator rejects tx ops whose account is feed-fed… client-only is
  acceptable for v1 since raw tx entry is client-authored anyway).
- **Naming in the UI**: the tier shows on account rows and the attach
  sheet — "Linked", "Imported", "Manual" (EN/NL/TR) — replacing the
  current manual/automated wording, so the user can predict behavior
  before tapping.
- **Balance**: manual accounts keep the live hand-maintained balance;
  linked/imported balances come from the feed only.
- **ING CSV importer** (new semi-linked source): same pipeline as
  CAMT.053 — parse, feed-space dedupe by IBAN, attach with history
  window. Slice below; other banks' CSVs follow the same adapter
  shape.

## Slices

- AT1 tier enforcement (camt053 joins the no-manual-tx rule) + tier
  labels on account rows / attach surfaces + EN/NL/TR + tests
- AT2 ING CSV importer (adapter beside importCamt, shared preview
  UI) + tests with a real-shape fixture
- AT3 docs/guide/tour touch-ups explaining the three tiers

## Related follow-up (unchanged)

Consent expiry push: the space accounts screen flags stale GoCardless
syncs client-side ("Reconnect?"); a server-driven push when a
90/180-day consent actually expires belongs in the notifications
backlog.
