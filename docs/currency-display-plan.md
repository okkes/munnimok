# Display-currency conversion — plan

Status: **DESIGN — awaiting approval** (2026-07-23). User request: a
VISUAL conversion layer — e.g. a euro account whose values render in
dollars at that day's rate — now that accounts carry their own
currency.

## Principle: raw money is never converted, only its rendering

Amounts stay stored in their account's currency forever (raw-data
law). Conversion happens at the last moment, in the formatting layer,
clearly marked as approximate. That keeps sync, budgets math and
reconciliation exact, and makes the feature purely additive.

## Design

1. **Rates**: daily reference rates from the ECB via OUR api (`GET
   /rates?date=` — server fetches/caches the ECB daily XML once,
   ~30 currencies, no API key, free). Client caches every seen day in
   a `rateCache` device table → offline shows the last known rate
   with its date. Offline profiles that never see a server can enter
   a manual rate per currency pair (stored locally) — honest fallback.
2. **Setting**: per SPACE display currency (`space.displayCurrency`,
   default = space currency). One toggle spot: space settings, next
   to the existing currency picker: "Show amounts in …". Per-account
   opt-out is deliberately NOT offered (mixed columns of silently
   different currencies is how spreadsheets lie).
3. **Rendering**: `fmtCents` grows a converting sibling
   `fmtDisplay(cents, fromCurrency, ctx)` used by the money surfaces
   (lists, cards, totals, budgets, charts). Converted values carry a
   marker: `≈ $1,234.00` — the ≈ is the promise that raw data is
   untouched. Detail screens show BOTH: original prominent, converted
   beneath.
4. **Totals across currencies** (the real win): the balance band and
   overview totals currently mix currencies numerically when accounts
   differ — with a display currency they convert-then-sum and mark
   the result ≈. This quietly fixes a correctness wart.
5. **Rate date**: conversions use the transaction's DATE rate when we
   have it (historical accuracy for lists), today's rate for balances
   and forecasts. The tooltip/detail line names the rate + date.

## Slices

- CD1 server /rates (ECB fetch + cache + history) + tests
- CD2 client rate cache + `fmtDisplay` + manual-rate fallback for
  offline profiles
- CD3 space setting + money surfaces adoption (lists, band, overview,
  budgets read-only views) with the ≈ marker + EN/NL/TR
- CD4 charts/trends + detail dual display + guide/tour touch-ups

Open questions:
1. OK that budgets keep their LIMITS in the space currency (only the
   rendering converts)? Alternative — converting limits too — makes a
   budget "move" day to day, which feels wrong to me.
2. Is the ≈ marker enough, or do you want an explicit banner when a
   space renders in a foreign display currency?
