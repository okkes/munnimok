# Debts — design

Status: **draft for approval** — nothing here is built yet.
Legacy debts screens are the inspiration (overview, payoff progress).

## The idea

One place that answers: **what do I owe, what am I paying, when am I
done?** Liability *accounts* already exist (credit/mortgage/loan) and
carry balances; the debts feature adds the payoff STORY on top: original
size, interest, monthly payment, projected end, progress.

## Data model

```
debt (synced, per space) {
  id, spaceId, name, icon,
  accountId?,                  // link a liability account (balance = truth)
  originalCents,               // starting size
  interestPctYear?,            // informational APR
  paymentCents?,               // the regular payment
  paymentDay?,                 // of the month
  merchantKey?,                // auto-link payments (recurring-style)
  archived?: 0 | 1             // paid off
}
```

Remaining balance: from the linked account when present (bank truth —
balance-as-of rules apply); otherwise `original − Σ linked payments`.
Payments auto-link exactly like recurring costs do (same merchantKey +
cycle machinery — the reconciler generalizes).

## The numbers

- **Progress** = 1 − remaining/original.
- **Projection**: with `paymentCents` (+ optional APR), a pure
  amortization walk gives the projected payoff date and total interest;
  shown as "debt-free in ~2y 4m (Sep 2028)".
- **Debts overview header**: total owed, total monthly payments, the
  earliest projected payoff — the "how deep am I in" glance.

## UX

1. **Debts screen** (Settings → This space → Debts): header totals,
   debt cards — name, remaining of original, progress bar (inverted
   ramp: green as it shrinks), "€X/mo · free Sep 2028".
2. **Debt detail**: hero numbers + projection line, payment history
   (linked transactions), amortization mini-chart (BarChart of
   remaining per year), edit behind the pencil.
3. **Create/edit** sheet: name, link-a-liability-account picker (or
   manual original amount), APR, payment + day, merchantKey via a
   "pick a past payment" shortcut.
4. **Home block** (customizer-pluggable): total owed + this month's
   payments state.

## Rollout

- **D1** — entity + overview + create/edit + manual balances.
- **D2** — account linking + payment auto-link (generalized
  reconciler) + detail history.
- **D3** — amortization projection + chart + home block.
- Tests: remaining math both modes, projection amortization, auto-link
  once per cycle.

## Open questions

1. Interest handling is *informational* (projection), not accounting —
   we never generate interest transactions. OK?
2. A debt linked to an account whose feed is shared: the debt story is
   still per-space (like budgets). Confirmed?
