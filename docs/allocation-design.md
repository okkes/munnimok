# Allocation (zero-based budgeting) — design

Status: **built 2026-07-09** (A1–A3 shipped: cells, chips, cover-from, home block, Age of Money).
The YNAB concept, munni-shaped; the legacy sketch is inspiration only.

## Confirmed rulings

1. Allocation at **main-category** level only (subs roll up). ✓
2. Rollover default **on**, per-space toggle. ✓
3. Unassigned income **carries** into next period's "to allocate". ✓
4. Extra YNAB latitude granted — adopted: **Age of Money** stat on the
   allocate header, and a **quick-fill underfunded** action that tops
   every envelope up to its budget suggestion where budgets exist.

## The idea

Every period, the money that came in gets a **job before it gets
spent**: you distribute the period's income across your categories
until nothing is left to assign. Spending then draws down each
category's assignment. The discipline is the point: *proactively*
decide, don't retroactively discover.

**Allocation and Budgets are siblings, not rivals**: budgets are
standing per-category limits; allocation is a per-period distribution
ritual over ALL your money. A space can use either, both, or neither
(hidden home blocks make this painless). Where both exist, the
allocation editor shows the budget amount as the suggested assignment.

## Data model

```
allocation (synced, per space) {
  id, spaceId,
  periodStart,                 // the space period it belongs to
  catId,                       // main category
  assignedCents
}
```

One row per (period, category) — deterministic id
`alloc:{spaceId}:{periodStart}:{catId}` so two devices editing the
same cell converge by LWW instead of duplicating.

Derived, all pure client math per period:
- **To allocate** = income received this period (overview 'income'
  rules) + optional carried unassigned from last period − Σ assigned.
- **Available per category** = assigned − spent (expense contributions
  of the family) + rollover of last period's leftover (YNAB-style,
  configurable per space: rollover on/off).

## UX

1. **Allocate screen** (Settings → This space → Allocation, plus a
   home block): the header owns the ritual —
   **"€1,240 left to allocate"** (green at exactly 0, amber when
   money is idle, red when over-assigned). Below: one row per main
   category — assigned input, spent, available pill (colored by sign).
2. **Fast entry**: tapping a row focuses its amount; quick chips
   *"= budget"*, *"= last period"*, *"= spent avg"*; a final
   *"assign the rest evenly"* action zeroes the header in one tap.
3. **Period nav** ‹ › like the overview; past periods read-only.
4. **Overspent categories** (available < 0) surface a "cover from…"
   move dialog — moving money between envelopes is the core loop.
5. **Home block** (customizer-pluggable): "€X to allocate" when
   non-zero, else "all money has a job ✓" with this period's most
   drained envelope.

## Rollout

- **A1** — entity + allocate screen + to-allocate math + assignment
  editing (LWW-converging cells).
- **A2** — available/rollover math + move-between-envelopes + chips.
- **A3** — home block + budgets cross-suggestions.
- Tests: to-allocate arithmetic (income sources, carry), rollover
  on/off, concurrent cell edits converge, move dialog math.

## Open questions

1. Allocation at **main-category** level only (subs roll up) — my
   strong recommendation for sanity. OK?
2. Rollover default: **on** (true YNAB) or off (fresh each period)?
   Proposal: on, per-space toggle.
3. Should unassigned income carry into next period's "to allocate"
   (proposal: yes)?
