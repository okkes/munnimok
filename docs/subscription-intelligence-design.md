# Subscription intelligence — design (PLAN, awaiting approval)

Status: proposal 2026-07-15 (shortlist #2). Small slice: everything
rides the existing recurring-cost rows and their linked transactions.

## The idea

Recurring costs are detected and tracked, but munni stays silent about
the two things that actually matter: *what does this cost me per year*
and *did the price quietly go up*. Both are derivable from the linked
transactions we already store.

## What changes

1. **Yearly cost, everywhere a recurring row shows.** `amountCents ×
   cyclesPerYear(interval)` — the Recurring screen's LUXURY badge line
   already shows "€25.00 this period · €300.00 a year" for some rows;
   this makes the yearly figure a first-class column on every row and
   a total header for the whole screen ("Your subscriptions:
   €2,340/year"). Zero new data.
2. **Price-change detection.** `domain/recurringPrice.ts`: from the
   linked transactions (newest N), detect a sustained amount change —
   two consecutive charges at a new amount = a change (one-off deltas
   like prorations don't trigger). Each recurring row gets an optional
   `priceChange` marker at read time (not stored): direction, old/new
   cents, since-date.
3. **Surfacing:**
   - Recurring list row: small "+€2.00" warning-tinted badge.
   - Recurring detail: a price-history line ("13.99 → 15.99 since
     May") above the payment history, plus the yearly delta ("that's
     +€24.00/year").
   - **Insights detector**: the existing price-creep detector fires on
     category drift; add/replace with a per-subscription detector so
     the Home insight reads "Netflix raised its price by €2.00" —
     dismissible like every insight, deduped by (recId, newAmount).
4. **Review hook (optional, decide):** when confirming a transaction
   linked to a recurring whose amount differs from the expected one, a
   quiet line "€2.00 more than usual" on the card.

## Impacted screens (cascade rule — pick what's in)

1. Recurring screen (yearly column + total header + change badges)
2. Recurring detail (price history + yearly delta)
3. Insights (new detector + copy EN/NL/TR)
4. Review card (the optional "more than usual" line)
5. Tour/guide touch-ups + what's-new entry

## Slices

- **S1**: domain detection + recurring list/detail surfacing
- **S2**: insights detector
- **S3**: review hook (only if wanted)

Effort: S1+S2 together well under one arc.
