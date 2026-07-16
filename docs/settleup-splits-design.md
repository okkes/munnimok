# Split sessions — settle-up v2 design (PLAN, awaiting approval)

Status: proposal 2026-07-16, supersedes-if-approved
`settleup-design.md` (kept untouched for comparison). Based on the
user's counter-proposal: **splits are their own scoped object inside a
space, with their own membership — not a shared space.**

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
