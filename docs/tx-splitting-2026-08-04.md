# Transaction splitting — typed parts of one payment (design plan, 2026-08-04)

Status: **PROPOSED — awaiting user pick.** Nothing here is implemented.
Companion visual: the published design artifact (mockups + impact map).

## What you asked for

One bank transaction, several *kinds* of money. The €87.40 card payment
that is mostly groceries but also pays €25 off a friend-loan; the salary
that is partly income, partly the expense your employer passed through.
Your call: split the transaction into parts — a sheet showing the single
transaction where you add splits, each split carrying its own value (sum
must equal the transaction), info auto-copied with "– split 1/2/…"
labels, and visuals that make the parts feel connected. You asked if I
had a better idea, and for a design plan covering review + detail + the
whole-app impact.

## What munni already has (and the ruling this reverses)

This is deliberately NOT greenfield. `TxSplit` already partitions one
transaction across categories (`splits?: TxSplit[]` on the raw row AND
the per-space `txMeta` overlay — the transformation layer carries it),
with a mature editor (`SplitEditorSheet`: € and % modes, exact-partition
validation, auto-balance, per-slice category pickers, the reimbursed
slice held aside), and half the app already fans slices out: overview,
trends, budgets, CSV export ("part" rows), category ops, review drafts.

What a slice CANNOT have today is its own **type** — `reviewDraft.ts`
encodes the old ruling "splits are single-type" and nukes splits on a
conflicting type change. Your request reverses that ruling: **slices
grow up into typed parts.** That framing is the whole design — we
mature the existing mechanism instead of building a rival one.

## Better-idea check: three models, one winner

1. **Real child transactions** (materialize N rows, hide the parent).
   Every consumer would work untouched — but it breaks raw-vs-
   transformation for bank rows (a split is a per-space *opinion* about
   one global raw row), double-counts against balances, bloats sync,
   and invents orphan/consistency problems (parent deleted, children
   stranded). Rejected.
2. **Virtual expansion in the join** (joinTx mints pseudo-rows).
   Seductive, but every write path would need virtual-id routing, and
   every real reference (`reimbursements[].txId`, `transferPeerId`,
   testids, activity) would need a second addressing scheme. Rejected.
3. **Typed slices on the existing partition** — extend `TxSplit`, keep
   one row per transaction, present the parts as connected sub-rows in
   detail and as a segmented visual in lists. One storage shape, one
   editor, one canonical read helper. **This is the plan.**

So: your instinct (split it up) is right, and the best mechanics for
munni are "the split you already know, now with type identity" — which
is also exactly the "like multi categories" feel you asked for.

## The model

```ts
export interface TxSplit {
  catId: string;
  amountCents: number;      // positive magnitude; direction = the row's sign (unchanged)
  pct?: number;             // % mode, materialized — unchanged
  // typed splits (2026-08-04), all optional — a bare slice behaves exactly as today:
  id?: string;              // stable slice identity (repo.newId()), minted on save
  label?: string;           // stored ONLY when the user edits it; the default
                            // "<title> – split N" is rendered at read time (localized)
  txType?: TxType;          // absent = inherit the row's type (every legacy slice)
  linkedAccountId?: string; // transfer-family slices: the MANUAL counter account
}
```

- **Effective type**: `slice.txType ?? row.txType`. The row's stored
  `txType`/`catId` stay the **largest slice's** (today's `primaryCatId`
  rule, extended to the type) — recurring detection, the pair matcher,
  merchant memory and filters keep seeing a sane primary.
- **Sign coherence per slice**: standard slices resolve by the row's
  sign (a negative row offers expense categories, a positive row income
  — `standardTypeFor`, automatic). Transfer-family and adjustment
  slices carry no sign rule, same as rows. New invariants: slice type
  in `TX_TYPES`; expense/income slices must match the row sign.
- **Slice kinds = the row's kind language.** Each part picks through
  the same `TxKindSheet` (Standard / Transfer / Adjustment) and the
  same `CounterpartySheet` (manual accounts + the bare family exits:
  saving, investment, loan payment, funding, transfer). Adjustment
  slices only on hand-made rows (same `allowAdjustment` rule).
- **v1 restriction — no bank-fed counterparties on slices.** A real
  transfer between two bank-fed accounts arrives as two whole raw rows
  and pairs whole-row (`transferPeerId` stays row-level, the list
  collapse untouched). Slices link **manual** accounts only, exactly
  the loans-v2 lane.
- **Balance coupling generalizes loans v2.** `applyLoanLinkDelta`
  becomes slice-aware: on split save, `writeTxTransform` diffs old vs
  new slices' `(linkedAccountId, magnitude)` and applies deltas to
  manual counter accounts — loans keep `countsTowardLoan` (row-date
  cutoff + the row-level `loanCounted` one-shot), savings/investment
  pots move by the slice magnitude. `transferPeerId` rows still skip
  (the mirror already carried it); no `balanceAsOf` stamping; the
  `TxFormSheet` direct-save path applies the same diff. Slice links do
  NOT mint mirror rows (loans already work this way; a per-slice
  mirror leg is a possible v2).
- **Reimbursements unchanged.** The `REIMBURSED_ID` slice stays a
  typeless bookkeeping slice, held aside by the editor and re-attached
  on save; `reimbursements[].txId` keeps pointing at rows.

### One canonical read helper — `domain/txSlices.ts`

```ts
interface SliceView { catId; amountCents /* signed */; effType; label; index; count; linkedAccountId? }
txSliceViews(tx): SliceView[]   // unsplit row → one view of the whole
```

Today every consumer type-filters at ROW level and only some fan
slices. All aggregation consumers migrate to this one helper, so
per-slice types are honest everywhere — and the pre-existing
split-blind spots (events, allocation, insights' smallHabit/weekend,
category search filter) get fixed by the same migration.

## The UX, surface by surface

**The sheet** — `SplitEditorSheet` grows from compact rows into
**part cards** and retitles to "Split transaction". Pinned header: the
single transaction (icon, title, account · date, immutable total) with
a live **segmented bar** — one segment per part in its category color,
hatched grey for the unassigned remainder. Each card: editable label
(placeholder "<title> – split N"), amount (text input with arithmetic —
`evalAmountCents`, the loans pattern — EU decimals, focus-empties),
kind chip row (opens TxKindSheet/CounterpartySheet per part), category
button (type-gated per PART), remove ×. "+ Add split" appends a card
pre-filled with the current remainder and the next auto-label; blocked
while a card is unfinished (existing rule). Remainder pill still
auto-balances on tap; €/% modes, the reimbursed holdout, review's
controlled draft mode, and the dirty guard all carry over. All three
existing doors (detail, manual form, review card) get the new powers by
construction.

**Lists** — one row per transaction stays (chronology, search counts,
pair collapse intact). `TxRow` gains: a thin segmented underline under
the amount when parts exist, and the subline upgrades from the neutral
"Mixed" to the top parts by size — "Groceries · Loan payment". Scoped
lists (category drill, budgets, event, loan payments) already show
slice amounts via `amountOverrideCents`; they add the part label.

**Transaction detail** — the categories section becomes the **split
section**: the segmented bar under the headline amount, then the parts
as connected sub-rows — a left spine (vertical line + a node per part)
visually tying them to the parent; each sub-row shows label, type chip
(only when it differs from the row's kind), category chip, signed
amount. Tapping a part opens the sheet focused on that card. Per-part
extras surface inline: a loan-linked part shows "pays debt →" and the
pre-anchor count-it-in CTA. The kind row reads "Multiple · 2 types"
when parts diverge and routes to the sheet instead of `TxKindSheet`.
The actions block (recurring/event links) unlocks when ANY part is an
expense, not just the row primary.

**Review** — the card already renders one category row per slice;
those rows gain the part label + type chip. The staged summary shows
the segmented bar. Draft coherence moves per-slice: a row-kind change
re-checks only INHERITING slices (typed parts keep their own type);
`draftReady` requires a real category per part unless the part's
effective type is transfer/funding/adjustment (the locked-sub
placeholder, `withFamilyCategory` per slice). Bulk "also apply to
similar" keeps its rules (absolute splits ride only to identical
amounts; % splits rescale) — but per-slice `linkedAccountId` is
**stripped** from bulk copies: a balance-moving link is this row's
reality, and `LoanMatchSheet` is the mass-linking door.

**Filters & search** — the type filter matches "row type OR any part's
type"; the category filter matches part catIds (today it is
catId-blind); the free-text search haystack gains part labels.

## What stays untouched

Recurring stays row-level (`recurringId`, detection on the primary
type: the bank-level pattern is the row). Transfer pairing stays
whole-row. Predictions and merchant memory read the primary. Sync is
additive fields inside an existing LWW value — the server stores rows
opaquely, zero server change. The service-worker budget alert reads
raw rows without the join (pre-existing limitation, unchanged).

## Migration & compat (both directions)

Purely additive optional fields: no data migration, old rows valid,
new rows pass old invariants (unknown slice fields ignored). Offline
works fully — splits are client data. The honest edge: an **old app
version** re-saving a typed row's splits rebuilds the array from
catId+amount and drops type/label/link metadata (whole-array LWW).
Visually self-healing (re-split), but a dropped slice-link would leave
a stale balance delta on the counter account — same exposure class as
every LWW array field; accepted and documented, mitigated by how rare
cross-version same-row split edits are.

## Impacted surfaces (pick what to include)

1. **Model + helper** — `TxSplit` extended fields; primary type/cat
   derivation; per-slice invariants; `domain/txSlices.ts` + tests.
2. **The sheet** — SplitEditorSheet → part cards (label, kind,
   counterparty, category, arithmetic amount), auto-labels, segmented
   bar, all three doors, i18n EN/NL/TR.
3. **Balance coupling** — slice-aware link deltas (generalized
   `applyLoanLinkDelta`, unlink refunds, loans cutoff honored,
   TxFormSheet direct path).
4. **Aggregation migration** — overview, trends, budgets, events,
   allocation, insights, CSV export move to `txSliceViews`; closes the
   pre-existing split-blind gaps; export gains type + label columns.
5. **Lists** — TxRow segmented underline + part summary subline; part
   labels in scoped lists.
6. **Detail** — split section with spine + per-part chips and loan
   CTAs; "Multiple" kind row; segmented bar under the amount.
7. **Review** — part labels/type chips on the card, per-slice draft
   coherence, staged split summary, bulk link-stripping.
8. **Filters & search** — slice-aware type/category filters, labels
   searchable.
9. **Optional: per-part events** — `eventId` on a slice ("this €30 of
   the dinner belongs to the trip"); event screens fan per part.
10. **Optional: LoanMatchSheet partial link** — "link part of this
    payment" mints a split + linked slice in one move.
11. **Polish pack** — activity entries, tours + user guide (the
    transactions section + split shot), DEV annotations, demo sample
    (rich seed only — amounts unchanged, e2e pins safe), What's New
    (next release), unit tests + one core-flow e2e, Sonar.

My recommendation: 1–8 + 11 as the arc; 9 and 10 are natural
follow-ups once the foundation is in.

## Open questions

- **A. Naming**: parts are labeled "split 1/2/…" (your word). The
  settle-up tab is also called "Splits" — different context, and I
  think it survives, but say the word and I'll use "part 1/2/…"
  (NL "deel", TR "bölüm") instead.
- **B. Bulk links**: strip per-slice loan/savings links from "also
  apply to similar" (my rec), or let them ride so four identical
  payments each move the loan?
- **C. Transfer scope v1**: slice counterparties = manual accounts +
  bare family names only; whole-row stays the door for bank↔bank
  transfers. OK?
- **D. Per-part events**: now (item 9) or later?
- **E. List presentation**: my rec is ONE row with the segmented
  underline (chronology/search/pair-collapse intact) and the connected
  sub-rows living in detail — the alternative (expanded child rows in
  every list) changes list semantics app-wide.
