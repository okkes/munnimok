# Transaction review — process redesign (PLAN, awaiting approval)

Status: **proposal 2026-07-14** — the user flagged that the review flow
lets state drift apart: "I can select expense, choose entertainment and
then change the type to saving — the category stays the same."

## The core problem

Type and category are entangled but edited independently:

- every category declares which `txTypes` it supports;
- the DETAIL screen already heals one direction (a type change that
  conflicts with the category resets it to uncategorized and re-flags
  review — `applyTypeChange`);
- the REVIEW screen does not: the staged category (`stagedCat`) is
  screen-local state, while the type sheet writes to the database
  directly. Changing the type after staging a category leaves an
  illegal pair on the card, and Confirm then derives the written
  txType from the category (`cats.byId(catId).txTypes[0]`), silently
  overriding the type the user just picked.

## Proposed model: one staged draft, one write

Review stops mixing screen state and database writes. Each card gets a
**draft**: `{ catId, txType, linkedAccountId, splits, recurringId }`,
initialized from the transaction + prediction. Every control on the
card edits the DRAFT; only Confirm writes (one `transform` call).
Skip/leave discards the draft. This gives:

1. **Type ⇄ category coherence by construction** — the draft applies
   `applyTypeChange` rules on every edit:
   - pick a category → the draft type becomes one the category
     supports (first declared, or keeps the current if compatible);
   - pick a type → an incompatible category clears to "pick one",
     Confirm disables until a category fits the type;
   - link a counter-account → type defaults from the account (still
     editable, per the shipped revision).
2. **No mid-review database churn** — today the type sheet and split
   editor write immediately, which also syncs half-decided edits to
   co-members. With a draft, members only ever see confirmed rulings.
3. **Cancel becomes honest** — skipping a card leaves zero trace.

### The card, reorganized

Top-to-bottom: merchant + amount + full description (shipped),
then the three decisions in dependency order:

1. **What is it?** — type + counter-account (one row, sheet as today);
2. **Which bucket?** — category chip (list filtered by draft type);
3. **Extras** — splits, recurring link, event link (splits editor works
   on the draft and enforces per-slice type compatibility).

Progress, bulk-confirm and skip stay as they are.

### Bulk confirm under the draft

The bulk list applies the DRAFT (type + category + split shape) to the
selected similar items on Confirm — same as today, but the type comes
from the draft instead of being re-derived from the category.

## Slices

- R1: extract a pure `reviewDraft.ts` domain module (init from tx +
  prediction; transitions for pickCategory/pickType/linkAccount/split;
  validity rule) with full unit tests.
- R2: ReviewScreen swaps its scattered state for the draft; sheets
  receive/return draft values instead of writing (`TxTypeSheet` and
  `SplitEditorSheet` get an optional controlled mode; the detail screen
  keeps their current write-through mode).
- R3: category picker filters by draft type live; Confirm disable rule;
  copy + EN/NL/TR; tour update.

## Decisions needed from the user

1. When a type change invalidates the category, should the card
   auto-suggest the closest valid category (e.g. history hit for that
   type) or always ask again? (Proposal: ask again — predictions
   already pre-fill the common case.)
2. Should split rows be allowed to span types (e.g. half expense, half
   saving)? Today splits are categories-only within one type.
   (Proposal: keep single-type splits; cross-type splitting is a
   different feature.)
