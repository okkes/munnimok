# Overview → category drill-down — design

Status: **approved 2026-07-09** — ready to build.

## Problem

From Home, an overview tile (Income/Expenses/…) opens the overview
screen: per-period bars, composition, main-category cards that unfold
into subs. Tapping a (sub)category today **forwards to the Transactions
tab** with a filter chip (`/transactions?catId&from&to`). That jump is
disorienting: you leave the analysis context, land in a tool built for
searching/managing, and the back story ("how did I get here?") breaks.
Legacy had the same smell — its expenses screen also ended in a
filtered list.

## Proposal: a category transactions screen inside the drill

New route: `/overview/$kind/$catId` (period travels as `?from&to`).

```
┌──────────────────────────────┐
│ ←  Groceries                 │   compact app bar, category name
│                              │
│   🛒  −€342.18               │   period total for THIS category
│   1 Jun – 30 Jun   ‹ ▸       │   period nav: stays in context,
│                              │   arrows hop periods (like overview)
│   ▂ ▄ ▆ ▄ █ ▅                │   6-period mini bars for the category
│                              │
│  PAYMENTS · 23               │
│  ┌────────────────────────┐  │
│  │ TxRow (tap → tx detail)│  │   the plain transaction values list
│  │ TxRow                  │  │   the user asked for; read-only
│  │ …                      │  │   browsing, no search/filters/add
│  └────────────────────────┘  │
└──────────────────────────────┘
```

- **Main category** rows list the whole family (main + subs), **sub**
  rows just the sub — same contribution rules as the overview
  (splits-aware, reimbursements netted, per `domain/overview`).
- Period navigation keeps you inside the category: comparing "Groceries
  in May vs June" is two taps, no context loss.
- Browser back walks the natural stack: tx detail → category list →
  overview → home.
- The mini bar chart doubles as the period selector (same `BarChart`
  component as the overview).
- The Transactions-tab forward (and its drill chip) disappears. The
  tab keeps its own search/filter powers for when you *start* there.

## Scope

- New screen + route, reusing `BarChart`, `TxRow`, `categoryBreakdown`
  helpers — no schema or sync work.
- `overview-sub-*` / `overview-all-*` taps re-point to the new route.
- i18n: screen needs no new strings beyond what exists (category name,
  payments caption reuses `recurring.payments`? — no: add
  `overview.payments` "Payments" NL "Betalingen" TR "Ödemeler" for
  clean semantics).
- Tests: route render, period nav changes the list, sub vs main
  scoping, back-stack.

## Out of scope (later, if wanted)

- Per-merchant grouping inside a category.
- Export of the drilled list.
