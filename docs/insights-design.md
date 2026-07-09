# Insights — design

Status: **draft for approval** — nothing here is built yet.
The legacy screen is the blueprint for the *feel*: expandable cards,
one-line verdict, a small chart and a paragraph that talks like a
sharp friend, not a bank. This doc turns its five mock cards into an
engine plus a curated detector catalog. Quality bar for every
detector: **computable from data we already have, a concrete €
number, and one obvious action.**

## How it works (the engine)

Insights are **pure detectors** over local data — transactions,
recurrings, budgets, goals, debts, allocations, accounts. No server,
no AI calls, no telemetry: they run identically for demo, offline and
signed-in users, recomputed locally when the screen opens.

```ts
interface Insight {
  id: string;            // deterministic: detector + period + subject
  detector: DetectorId;
  impactCents: number;   // yearly € impact — the ranking key
  severity: 'leak' | 'pattern' | 'win';
  titleKey; subKey; detailKey; params;   // i18n ×3, evidence baked in
  chart?: number[];      // the legacy mini bar chart
  action?: { to: string };               // deep link: the fix lives there
}
```

- **Ranking**: by yearly impact, wins capped so praise never buries a
  leak. The screen shows everything; the home block shows the top one.
- **Dismissal**: per insight id, so a dismissed card stays gone until
  its subject changes (new period, new amount → new id, resurfaces).
- **Thresholds**: every detector has a minimum € impact and minimum
  data window before it may speak. No data-starved guesses — an
  insight that can't prove itself stays silent.

## The catalog

### Leaks (money quietly walking out)

1. **Price creep** — a recurring cost charges more than it used to
   (Netflix 13,99 → 15,99). We already link payments to recurrings;
   compare charge history. *"3 subscriptions got €4,50/month more
   expensive this year — €54/year."* → recurring detail.
2. **Subscription overlap** — two+ active subscriptions in the same
   category (two music services, three streamers). *"Netflix + Disney+
   + Videoland = €31/month for one couch."* → recurring tab.
3. **Luxury subscription audit** — the recurring `luxury` flag exists;
   sum them yearly, ask the legacy question: *"used all of them this
   month?"*
4. **Trial that became a bill** — a small new recurring whose amount
   jumped within its first two periods. Classic forgotten trial.
5. **Duplicate charge** — same merchant, same amount, within 48 hours.
   Rare, but when it fires it's real money. → both transactions.
6. **Fee hunter** — bank/ATM/FX fee categories totalled per year.
   *"€67/year in fees — €31 of it foreign ATM withdrawals."*
7. **Delivery habit** — delivery/takeaway merchants (Thuisbezorgd,
   Uber Eats…) per month, extrapolated. The gentle version of the
   legacy coffee card, aimed where Dutch money actually leaks.
8. **Small-habit aggregation** — the legacy coffee card, generalized:
   any repeated small same-merchant purchase (≥12×/period). *"41
   coffees = €173 this period; 3×/week instead would keep €480/year."*

### Patterns (know thyself)

9. **Weekend multiplier** — Fri–Sun vs Mon–Thu daily spend (legacy
   card). Names the single biggest weekend category.
10. **Payday splurge** — the three days after income lands vs your
    baseline daily spend. *"38% of the month's fun spending happens in
    72 hours."*
11. **Category creep** — a main category running >30% above its own
    3-period average, minimum €25/period impact. → overview drill.
12. **Grocery mix** — spend share per supermarket. No preaching, just
    the split — people are consistently surprised by it.
13. **No-spend days** — count per period, streak tracking. Positive
    reinforcement; pairs with the review habit.

### Progress & safety (the encouragement layer)

14. **Savings-rate streak** — the legacy "on track" card: rate per
    period, improvement streak, honest dip callouts.
15. **Emergency runway** — savings balance ÷ average monthly
    expenses. *"3,2 months of buffer — most advice says 3–6."*
16. **Idle cash** — checking consistently holding more than next
    period's bills + a buffer while a savings account exists.
    *"€1.400 has been idle on your checking account for 3 months."*
17. **Budget reality check** — a budget that overshot 3 periods
    straight (or always ends >95%) gets a suggested realistic limit
    from actual spend. → budget edit.
18. **Goal pace check** — goals behind their needed monthly pace
    (needs €120/month, getting €60). → goal detail.
19. **Debt acceleration** — we already have the amortization walk:
    *"€25/month extra on 'Student loan' = debt-free 14 months sooner,
    €380 less interest."* → debt detail. The single most motivating
    number in personal finance.
20. **Uncollected reimbursements** — linked reimbursements still open
    after 30 days. *"€86 is still owed to you."* → transaction.
21. **Fixed-cost share** — recurring costs as % of income; flag >50%.
    The number that explains why a month feels tight.
22. **Long-game projection** — the legacy 5-year card: current savings
    rate compounded (configurable return, default 7%) — becomes real
    once the investments feature lands.

## UX

1. **Insights screen** (Settings → This space → Insights, plus a home
   block): ranked cards in the legacy expandable pattern — icon, title,
   one-line verdict; expanding reveals the mini bar chart, the detail
   paragraph and the action button. Dismiss under the expansion.
2. **Home block**: the top undismissed insight as a one-liner card.
3. **Freshness line** like legacy: "Based on your last 6 periods".
4. A `?` tour, EN/NL/TR strings, dark/light — the usual laws.

## Rollout

- **N1** — engine (registry, ranking, dismissal, i18n plumbing) +
  screen + home block + first six detectors: price creep, overlap,
  small-habit, weekend, budget reality check, debt acceleration.
- **N2** — payday splurge, category creep, fee hunter, delivery habit,
  duplicate charge, savings-rate streak, runway, reimbursements.
- **N3** — idle cash, grocery mix, no-spend days, fixed-cost share,
  trial detector, projection (post-investments).
- Tests: every detector is a pure function → table-driven unit tests
  with crafted histories; threshold/silence cases explicitly covered.

## Open questions

1. **Dismissals**: synced per space (dismissed for everyone) or
   per device? My pick: synced — an insight is about the space's
   money, and double-dismissing annoys couples.
2. **Digest notification**: a weekly "2 new insights" push (reusing
   the budget-alert plumbing), or keep insights pull-only? My pick:
   pull-only in N1, digest later.
3. The N1 six — right picks, or swap any from the catalog?
4. Tone check: the detail copy above talks like a sharp friend
   (legacy style). Keep, or more neutral?
