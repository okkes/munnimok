# Split sessions — settle-up v2 design (APPROVED 2026-07-16 · SP1–SP3 DELIVERED)

**SP2 shipped** (2026-07-16, v1.18.0): add-from-space-transactions —
multi-select search over the member's OWN attached space's LOCAL
database, copied in as frozen snapshots with a private `sourceTxId`
backlink — plus the per-expense share editor (custom shares must sum).

**SP3 shipped** (2026-07-16): share-link invites (any member mints; one
active link per split, 7-day expiry, reminting retires the old link),
join screen showing ONLY split name + inviter with the per-member
space-attachment picker, and the guest-hardening server test: split
membership grants ZERO space-scope access (sync pull/push both 403).
The splits tour ships with SP3 as planned. Invite by user id was folded
into the link (one mechanism, same guarantees).

**SP4 shipped** (2026-07-16): Settle buttons on the transfer plan (a
settlement is an ordinary entry whose only share holder is the
receiver — no ledger special-casing) and owner-only Close (locks
entries + invites server-side; the client hides every mutating
affordance). **Deviation:** review transfer-linking ("this incoming
transfer looks like Anna paying you back") moved into SP5 — it shares
the reimbursement-candidate mechanics with the event work and deserves
one integration pass instead of two half ones.

**SP1 shipped** (2026-07-16): server model (splits / splitMembers with
per-member `attachedSpaceId` / splitEntries with ALWAYS-materialized
frozen shares), membership-gated REST (`/splits…`, outsiders get 404 —
existence itself is private), pure `domain/splitLedger.ts` (net
positions + deterministic greedy netting, one formula covers expenses
AND settlements), Splits list + detail screens (create, manual
expenses with payer chips, balances + "A owes B" plan), Settings entry,
EN/NL/TR. Deviations from the sketch: plain REST + reload instead of a
`split:{id}` oplog scope (revisit when SP3's invites make live updates
matter), and per-member attachment stored on the membership row rather
than a separate synced table. The feature tour ships with SP3 when
invites complete the story. **Next: SP2 (add from space transactions),
SP3 (invites + guest hardening), SP4 (settle + review link), SP5
(event link).**

Approved with answers: guests CAN add manual entries (Q1: yes),
currency fixed at creation (Q2), members settle / owner closes (Q3).
Supersedes `settleup-design.md` (kept for comparison).

**Clarified attachment model (user, 2026-07-16):** a split is NOT owned
by one space. **Each member attaches the split to one of their own
spaces when joining** ("to which space should this split attach?").
Consequences, folded into the model below:
- `splits` loses `spaceId`/`eventId`; per-member attachment lives in
  `splitAttachments { splitId, userId, spaceId, eventId? }` (synced in
  the member's own space scope — it's personal wiring, not split data).
- Transaction search shows ONLY the searcher's attached space's
  transactions — never another member's.
- Event link is per member too (an event in THEIR attached space). When
  a member links their event, transactions THEY added from search are
  auto-attached to that event if not already linked — including
  retroactively at link time and for later additions.

## Why the space-bound model was wrong (agreeing with you)

- Splitwise cohorts are ad-hoc: trip buddies, colleagues, a weekend
  group. A munni space means "see my transactions" — an invitation
  most of these people should never get, and one accidental attach
  away from oversharing.
- One space per split scatters data and makes the space list a
  graveyard.
- Events often live in a PERSONAL space; binding settle-up to shared
  spaces made "what did the Barcelona trip cost, and who owes me"
  impossible to answer in one place.

The one thing the old design got right — the ledger math, share
editing, settle mechanics — carries over unchanged.

## The model

A **split session** (working name: "Split") is a row owned by a space
but with **independent membership**:

```
splits:        { id, spaceId, name, eventId?, currency, status: open|settled, createdBy }
splitMembers:  { splitId, userId, role: owner|member, joinedVia: space|invite }
splitEntries:  { id, splitId, kind: expense|settlement,
                 paidBy, description, amountCents, date,
                 shares?: { userId, cents }[],        // omitted = equal
                 sourceTxId?, sourceAccountId? }      // backlink, adder-only
```

**Membership rules (yours, verbatim):**
- Space contributors/owners can self-join any split of the space.
- Split members can invite ANYONE by user id or invite link — no
  friendship required, no space access granted.
- Split members see ONLY the split: its entries, members, ledger.
  Never the space, its accounts, or its transactions.

**Adding expenses:**
- From the space: a member who can see the space's transactions picks
  them from a search sheet (per your rule: transactions of the space's
  attached financial accounts). Adding **copies a snapshot** (merchant,
  amount, date, currency) into `splitEntries` — the split never holds a
  live reference outsiders could follow, and later edits to the source
  tx don't rewrite the group's agreed history. The backlink
  (`sourceTxId`) is visible only to whoever added it ("open original").
- Manual: anyone in the split can add a free-form entry not tied to
  any account ("Airbnb, paid cash by Anna").

**Event link:** `eventId` lives on the split and points at an event in
the OWNING space. The event detail shows the split's ledger summary
next to its own totals; split guests never see the event. This works
regardless of the space being personal or shared — your key
requirement.

## Sync & availability

Online-only, as you suggested — but not plain REST: split entries ride
the existing oplog machinery under a **new scope `split:{id}`**
(HLC/LWW per field, same envelope). Members subscribe to the scopes of
their splits; the server authorizes scope access by `splitMembers`, not
space membership. That reuses everything we trust (conflict handling,
SSE fan-out) while keeping guests strictly outside space scopes. Local
cache makes the screen readable offline; edits require connection
(entry creation goes through the API to validate membership — demo and
offline identities don't see the feature at all).

## The ledger (unchanged from v1)

`domain/settleUp.ts`: per member `paid − fair share = net`; pairwise
debts minimized (greedy netting); pure and heavily unit-tested. Equal
split uses the member set **frozen per entry at add time** (stored in
`shares` when members change later — no drifting history).

**Settling:** "A owes B €123" + Settle button records a settlement
entry; when the actual bank transfer shows up in B's feed, review
suggests linking it (same candidate mechanics as reimbursements).
A reimbursement-linked expense reduces the payer's paid total, same
ruling as v1.

## Surfaces (cascade rule — pick what's in)

1. **Splits list** — inside the space (Settings → Splits, or a block
   on Home when any split is open) + "New split".
2. **Split detail** — entries list, members, ledger ("who owes whom"),
   add-expense (from space tx / manual), Settle buttons, event link
   row (owner only).
3. **Invite flow** — share link / user id; the invitee sees a join
   screen with ONLY the split name + inviter.
4. **Tx search sheet** — space transactions with amount/date filter,
   multi-select add.
5. **Event detail** — "Split: {name} · you're owed €x" summary row.
6. **Review** — link incoming transfer to an open settlement.
7. i18n ×3, tour, guide, what's-new.

## Slices

- **SP1**: model + split scope sync + splits list + detail with manual
  entries + equal-split ledger (the walking skeleton).
- **SP2**: add-from-space-transactions (snapshot copy) + share editor.
- **SP3**: invites for non-friends + join screen + guest permission
  hardening (server tests: guest can NEVER read space scope).
- **SP4**: settle + review transfer-linking.
- **SP5**: event link + Home/event summaries.

Effort: SP1 and SP3 are the heavy ones (new authz scope); SP2/4/5 ride
existing patterns. Recommend shipping SP1–SP2 together, SP3 with extra
server-side tests before any real guest is invited.

## Open questions

1. Can a split guest (non-space member) ADD manual entries? Proposed:
   yes — that's half the point of Splitwise. Only space transactions
   require space visibility.
2. Split currency: fixed at creation (proposed) or multi-currency
   entries with conversion? Proposed: fixed, manual entries must match.
3. Who can settle/close: any member records their own settlements;
   only the split owner closes the session. OK?
