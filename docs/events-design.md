# Events — design

Status: **draft for approval** — nothing here is built yet.

## The idea

An **event** groups transactions around a real-world happening — a
holiday, a wedding, moving house — so you can see what it truly cost
and plan the next one. Space-scoped and synced (a shared trip in a
shared space is the whole point).

## Data model

```
event (synced, per space) {
  id, spaceId, name, icon, color?,
  from?, to?,                  // optional date range
  budgetCents?,                // optional planning number
  archived?: 0 | 1             // done events keep their story
}
transaction.eventId?: string   // one event per transaction (overlay field)
```

One event per transaction keeps the mental model simple (an expense
belongs to the trip or it doesn't); splits already cover mixed cases.

## UX

1. **Events screen** (Settings → This space → Events): cards with name,
   date range, total spent (live), optional budget bar, archived
   section. Tap → detail.
2. **Event detail**: hero (total, per-day average when dated, budget
   bar), category mini-breakdown (reusing the overview helpers), the
   transaction list (TxRow → detail), edit/archive behind the pencil.
3. **Attaching**: from tx detail ("Add to event…" picker + inline
   create); bulk-attach from the event detail via a date-range
   suggestion ("23 transactions fall inside these dates — attach?") —
   the fast path after a holiday.
4. **Home**: an optional landing-zone block (plugs into the existing
   block customizer) showing the ACTIVE event (today inside its range)
   with running total — the "how much has this trip cost so far" glance.

## Numbers

Spent = expense contributions of the event's transactions (same
splits/reimbursement-aware rules as the overview). Comparing events of
the same kind is v2 (needs tags/kinds) — the archive list sorted by
total already answers "what did the last three holidays cost".

## Rollout

- **E1** — entity + tx field, events screen + detail + attach from tx.
- **E2** — date-range bulk attach + home block + budget bar.
- Tests: totals math, attach/detach round-trip, shared-space sync
  convergence.

## Open questions

1. One event per transaction (splits handle overlaps) — confirmed?
2. Should archiving be automatic when `to` passes (my proposal: no —
   people keep adding late costs; manual archive)?
