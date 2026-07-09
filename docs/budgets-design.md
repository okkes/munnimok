# Budgets — design

Status: **built 2026-07-09** (P1–P4 all shipped).
Legacy `apps/legacy/src/features/budgets` used as inspiration only
(urgency color ramp, over-budget hatching, carry-over card, category
exclusivity badges); everything below is designed for the synced,
local-first app.

## What a budget is

A **space-scoped** spending limit over one or more categories that
resets on a fixed cadence. Spending inside the period counts against
the limit; the app warns before the money runs out.

## Data model (synced entity `budget`, per space)

```
{
  id, spaceId,
  name, icon,                     // icon from the category icon set
  amountCents,                    // the limit per period
  every: 'week' | '2weeks' | 'month',
  anchor,                         // yyyy-mm-dd the cycle counts from
                                  // (prefilled: space period day)
  catIds: string[],               // main and/or sub categories
  carryOver: 0 | 1,               // unused money rolls into next period
  carryMode: 'periods' | 'cap',   // how roll-over is limited…
  carryPeriods?: number,          // …carry at most N periods forward
  carryCapCents?: number,         // …or accumulate to at most this cap
  notifyAtPct?: 80 | 90 | 100,    // push threshold; unset = quiet
  active: 1 | 0
}
```

- **Spent** = period's expense contributions in `catIds` (splits-aware,
  reimbursements netted — same rules as the overview). A **main**
  category counts itself + all subs.
- **Category exclusivity (per space):** a category may live in exactly
  one budget. The picker disables taken categories with a badge naming
  the owner: *"In ‘Groceries’ budget"* (legacy pattern). Choosing a main
  category also claims its subs (and vice versa) — the picker explains
  which budget owns the conflict.
- **Carry-over** is *computed, never stored*: replaying the last
  `carryPeriods` (or until `carryCapCents`) from the transaction
  history keeps devices convergent with zero sync surface. Effective
  limit = `amountCents + carriedCents`.

## Screens

1. **Budgets list** (`/budgets`): cards sorted by urgency (over first,
   then least % left). Card = icon tile, name, "€X left / €Y over"
   colored by the urgency ramp (green → amber → orange → red, hatched
   overlay when over — legacy ramp, mapped to our tokens), progress
   bar, "resets weekly · carry €12" footnote.
2. **Budget detail** (`/budgets/$budgetId`): donut (% spent), period
   nav (‹ current ▸ like the overview), carry-over line, per-category
   spend rows (tap → the overview category drill), then the period's
   transactions (TxRow → tx detail). Edit behind the pencil.
3. **Create/edit** — full screen, not a sheet (too much content):
   name + icon row, amount, cadence chips (weekly / every 2 weeks /
   monthly) + anchor day, category checklist with exclusivity badges,
   carry-over toggle → mode (N periods / cap €) inputs, notify
   threshold chips (off / 80% / 90% / 100%).
4. **Home block** ("landing zone" pattern): the **3** most urgent
   budgets (over or closest to their limit), mini progress bars,
   ordered by urgency; tapping a row → its detail, "See all" → the
   list. Hidden until the space has budgets.

## The low-budget push notification (app closed)

The server must stay domain-agnostic — it cannot compute budgets. But
it already wakes devices: a bank ingest sends a push and the service
worker **pre-syncs** the new transactions (`backgroundPull`). We extend
that moment: after the pull, the worker evaluates the space's budgets
locally (pure domain function over IndexedDB) and shows a local
notification when a budget **crosses** its `notifyAtPct` (crossing,
not sitting above — one notification per period per budget, tracked in
worker meta like recurring reminders).

- Covers the real case: "my card got charged while the app was closed".
- Manual entries evaluate on the device that typed them (app open) —
  same crossing rule, so no double notifications.
- Notification deep-links to the budget detail via the existing
  worker → app NAVIGATE channel.

## Rollout

- **P1** — domain: `budget` entity + schema, spent/carry computation,
  exclusivity rule, urgency ordering (pure functions, unit-heavy).
- **P2** — screens: list, detail, create/edit (EN/NL/TR from day one).
- **P3** — home block + overview-drill cross-links.
- **P4** — worker evaluation + push crossing notification + deep-link.
- Tests: convergence (two devices editing a budget), carry-over replay
  determinism, exclusivity picker, crossing-once notification.

## Confirmed rulings (2026-07-09)

1. Cadence stays `week | 2weeks | month` — no custom "every N days". ✓
2. Carry-over ships **both** modes behind one toggle ("for N periods"
   *or* "up to € cap"). ✓
3. Home block shows the **3** most urgent budgets. ✓
4. Budget currency follows the space currency. ✓
