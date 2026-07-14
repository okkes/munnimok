# Trends & net worth — design (PLAN, awaiting approval)

Status: proposal 2026-07-15 (shortlist #1). Pure client-side domain
work on existing data; no server change, no new dependency (charts are
hand-rolled SVG, keeping the bundle local-first-small).

## The idea

Two questions the app can't answer today: *"how has my spending in X
developed?"* and *"is my total money going up?"* Both answered on one
new **Trends** screen, reached from Settings → Learn (next to
Insights) and optionally as a Home block.

## Screen layout

Tab-chips at the top switch three views:

1. **Categories** — vertical monthly bars, last 12 periods (uses the
   space's period type, so week-budgeters see weeks). Default: total
   expenses; tapping a bar opens that period's overview drill
   (existing screen). A main-category picker (the existing per-space
   filtered list) narrows to one main; a second tap narrows to a sub.
   Average line overlaid; current period rendered hollow (incomplete).
2. **Cash flow** — income vs expense bars per period (green above the
   axis, red below), net line on top. The "am I living within my
   means" view.
3. **Net worth** — line chart over time. Balance history is
   reconstructed, not stored: for every account,
   `balance(t) = balanceNow − Σ tx.amount after t`, computed once per
   render from the local db. Manual accounts with sparse edits get a
   stepped line from their `balanceAsOf` stamps. Portfolio holdings
   join at current quote flat-backwards (v1 honesty note in the UI:
   "investments shown at today's prices").

## Data & domain

- `domain/trends.ts`: `periodBuckets(txs, period, n)`,
  `categorySeries(txs, catId?)`, `netWorthSeries(accounts, txs, days)`
  — pure functions, unit-tested against fixed fixtures.
- Reimbursements: series use the NET amounts (consistent with lists).
- Excluded: transfers between own accounts (they'd double-count),
  pending transactions.

## Chart component

`ui/charts/Bars.tsx` + `ui/charts/Line.tsx`: minimal SVG, theme-aware
(CSS vars), no animation library — `transition` on heights only.
Accessible: each bar is a focusable button with an aria-label.

## Impacted screens (cascade rule — pick what's in)

1. New `/trends` screen (three views above)
2. Settings → Learn: new "Trends" row
3. Home: optional "Net worth" block (sparkline + delta vs last period),
   hidden by default, enabled via Customize Home
4. Overview drill: "see trend →" link in the header (jumps to
   Categories view pre-filtered)
5. Tour + guide section + EN/NL/TR strings + what's-new entry

## Slices

- **T1**: domain + Categories view + settings door (the meat)
- **T2**: Cash flow + Net worth views
- **T3**: Home block + overview drill link

Effort: T1 ≈ one arc, T2/T3 well under one each.
