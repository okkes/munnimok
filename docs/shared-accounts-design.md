# Financial accounts ⇄ spaces — design (feature "B")

Status: **draft for approval** — nothing here is built yet.
Supersedes the earlier draft; folds in the P2 rulings (global accounts
overview, balance-as-of dating, auto-reconnect on rejoin, same-space
reimbursements) and the new decision that **accounts are fully separate
from spaces** — manual accounts included.

## The idea in plain language

A bank account's transactions are facts: date, amount, merchant, what
the bank said. Those facts are the same no matter who looks at them, so
they exist **once, globally per account** — an account belongs to *you*,
not to a space. What people *do* with a transaction — category, notes,
splits, reimbursements — is an opinion, and opinions belong to a
**space**: the same Albert Heijn payment can be "Groceries" in your
personal space and "Household · shared" in the space you share with
your partner.

So the model splits in two:

- **Raw data** (the account truth): stored once per financial account in
  a dedicated *account feed*. Nobody edits it — it grows via GoCardless,
  CAMT import, or (for manual accounts) the owner's typed entries.
- **Transformation data** (the opinions): category, type, notes, splits,
  reimbursements, review flag. Stored per space, one overlay row per
  (space, transaction).

You **attach** an account to any space; members read its transactions
from the attachment's history-start onward and keep their own overlay.
Detach ends the flow of new data; history already shared stays.

## The full interaction map

Every scenario we could think of, with its intended behavior. ✱ marks
new rulings to confirm.

### Creating accounts

| # | Scenario | Behavior |
|---|---|---|
| A1 | Create a manual/cash account | Created **globally** (its own feed, owner = you). Not in any space until attached. The create flow ends with "attach to a space?" prefilled with the space you came from — skippable. ✱ |
| A2 | Connect a bank during **onboarding** | Accounts created globally + **auto-attached to your personal (default) space**, historyFrom = oldest fetched transaction. |
| A3 | Connect a bank later (from Accounts overview or a space) | Created globally; attach prompt prefilled with the space you started from (personal if started from the global overview). |
| A4 | CAMT.053 import | Import targets an **account**, not a space (picker: my accounts matching the file's IBAN, else create). New raw rows land in the feed and appear in every attached space. |
| A5 | Import a file for an IBAN a GoCardless account already covers | Same feed (ids derive from IBAN) — dedupe is automatic, no new account. |

### Attaching & detaching

| # | Scenario | Behavior |
|---|---|---|
| B1 | Attach via **space settings** | Space settings → Accounts → *Attach account*: searchable list of **your** accounts not yet attached (search matches name/IBAN, results highlighted). Pick history-from (prefilled from the space's history start). |
| B2 | Attach the same account to **multiple spaces** | Allowed and normal. Raw rows exist once; each space keeps its own overlay (its own categories/notes/splits). |
| B3 | Detach | New transactions stop flowing to that space. Already-shared history stays readable (archived attachment). A separate, explicit *Remove history* action tombstones the space's overlay rows if the space really wants the account gone. ✱ |
| B4 | Re-attach after detach | The attachment un-archives and the feed continues — deterministic ids mean no duplicates, the gap backfills. |
| B5 | Attach with a later history-from | Only raw rows ≥ history-from materialize in the space. Changing history-from later (earlier) backfills; (later) hides but keeps overlay rows. |

### Shared spaces & members

| # | Scenario | Behavior |
|---|---|---|
| C1 | Member attaches their account to a shared space | All members see its transactions (from history-from) and the account's name + **balance-as-of** the last shared datum (P2 ruling). Owner keeps sole write access to the raw feed. |
| C2 | Member with role *reader* | Sees raw + overlay, cannot edit the overlay (already enforced server-side). |
| C3 | Attaching member **leaves** the space | Attachment archives: shared history stays readable, no new data flows, the space shows "reconnect via your bank". |
| C4 | That member **rejoins** | **Auto-reconnect** (P2 ruling): their attachments in that space un-archive and the feed catches up. |
| C5 | Another member connects the **same bank account** | Same IBAN → same feed → the archived attachment continues seamlessly, no duplicates. |
| C6 | Reimbursements | Stay **within one space's overlay** (P2 ruling): a reimbursement linked in your personal space does not appear in the shared space. |

### Lifecycle & edge cases

| # | Scenario | Behavior |
|---|---|---|
| D1 | Delete an account (global) | Confirm names every space it is attached to. Feed tombstones; attachments archive everywhere; balances recompute. Overlay history stays per B3 semantics. ✱ |
| D2 | Bank consent expires (~90 days) | Account gets a global *reconnect needed* state, surfaced on the Accounts overview **and** in every attached space's settings. Reconnect resumes the same feed. |
| D3 | Space deleted | Attachments die with it; accounts and their feeds are untouched. |
| D4 | Demo identity | Same model, all local; bank connect hidden (zero network). |
| D5 | Offline identity | Same; manual + CAMT only. |
| D6 | Balance display | Balance is raw account truth, same in every space; shared spaces show it **as-of** the last shared transaction date (P2 ruling). |

### UI surfaces

1. **Accounts overview** (Settings → Financial accounts) becomes the
   **global** list (P2 ruling): every account you own, its balance,
   reconnect state, and chips naming the spaces it feeds. Actions:
   create, connect bank, import file, attach, delete.
2. **Space settings → Accounts**: what feeds this space — attach
   (searchable picker), history-from, detach/archived state, per-member
   ownership labels.
3. **Transactions/detail**: unchanged visually; the app joins raw +
   overlay transparently.

## How it maps onto the sync system

Unchanged from the earlier draft (feeds are sync spaces with derived
read access; `txMeta` overlay entity; attachment mirrored as a synced
`accountLink` row; auto-categorization client-side on first sight;
migration is a one-time idempotent client-side job with dual-read
during rollout). See git history of this file for the full technical
section — it still applies verbatim, now including manual accounts
(their feed's only writer is the owner's devices instead of the
GoCardless ingest).

## Build order

- **P1** — schema + domain: `txMeta`, `accountLink`, join layer,
  prediction-on-first-sight; LWW convergence tests.
- **P2** — server: attachment endpoints, derived feed access,
  archive-on-leave, auto-reconnect-on-rejoin.
- **P3** — migration + dual-read, verified on staging.
- **P4** — UI: global overview, space-settings attach flow (B1),
  onboarding auto-attach (A2), reconnect states.
- **P5** — e2e: two users, one feed, different overlays; leave/rejoin;
  same-IBAN reconnect continues the feed.

## Confirm before building (the ✱ marks)

1. A1: manual accounts also global-first with an attach prompt — OK?
2. B3/D1: detach keeps shared history unless *Remove history* is used
   explicitly — OK?
3. D6: balance-as-of shown to all members of a space an account is
   attached to (name + balance, not the owner's other accounts) — OK?
