# Cash-flow forecast — design (PLAN, awaiting approval)

Status: proposal 2026-07-15 (shortlist #4). "How much can I still
spend before payday?" — the single most useful number in personal
finance, and all its inputs already exist.

## The number

```
safe = liquid balance
     − recurring costs due before payday
     − allocation already promised (if the space allocates)
```

- **Liquid balance**: checking + cash accounts of the space (savings,
  brokerage, credit, loans excluded).
- **Payday**: the next due date of the recurring INCOME row (salary is
  detected today as a recurring credit). Several incomes → the
  earliest. None detected → the block hides (never guess silently).
- **Recurring costs due before payday**: existing `nextDueDate` logic,
  summed.
- **Allocation**: if the space uses allocation, subtract the unspent
  remainder of this period's assigned cells (money that has a job
  isn't safe to spend). Spaces without allocation skip this term.

A companion figure divides by the days remaining: "≈ €23/day".

## Where it lives

A **Home block** (Customize Home; visible by default when a salary
recurring exists): "Safe until 25 Jul — €412 (≈ €23/day)". Colored by
health: accent when comfortably positive, warning under one week of
average daily spend, negative red.

Tapping opens a breakdown sheet: liquid balance, minus each upcoming
recurring cost (rows link to their detail), minus allocation
promises, equals safe-to-spend. Full transparency — the number must
never feel like magic.

## Domain

`domain/cashflow.ts`: `nextPayday(recurrings, today)`,
`safeToSpend({accounts, recurrings, allocations, period, today})` →
`{ cents, payday, days, perDay, parts }`. Pure + unit-tested with
fixed dates (calendar-sensitivity rule: pin dates, never "today" in
assertions).

## Honesty rules

- Pending transactions already reduce balances at the bank → not
  subtracted again.
- Unreviewed transactions count (they're real money movements).
- The block shows nothing rather than a wrong number: no salary
  detected, or liquid balance unknown (no accounts) → hidden, with a
  one-time tip in the customize sheet explaining why.

## Impacted screens (cascade rule — pick what's in)

1. Home block + breakdown sheet
2. Customize Home (new block entry, default on when payday known)
3. Recurring detail: "part of your safe-to-spend forecast" line
   (optional)
4. i18n EN/NL/TR, tour touch-up, guide, what's-new

## Slices

- **F1**: domain + Home block + breakdown sheet
- **F2**: allocation term + per-day coloring polish

Effort: F1 ≈ half an arc, F2 small.
