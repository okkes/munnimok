# munni — feature analysis & gap review (2026-07-15)

A critical pass over what exists, then what comparable finance apps
(YNAB, Actual, Monarch, Copilot, Buddy, and the NL trio Grip/Dyme/
banks' own apps) offer that munni doesn't. Ends with a recommended
shortlist.

## What's genuinely strong (keep investing)

- **Local-first + shared spaces** is the differentiator. None of the
  mainstream apps do offline-capable multi-person spaces with per-field
  convergence. The feed/overlay split (raw bank truth once, opinions
  per space) is architecturally ahead of most commercial products.
- **Review as a teaching loop** — prediction with visible reasons,
  bulk-confirm, draft-until-confirm. Copilot is the only commercial app
  with comparable category UX.
- **Privacy posture** (device-only store tokens, zero-telemetry modes,
  read-only AIS, no server-side finance interpretation) is a real
  selling point; keep it loud in the guide.
- **Receipts with line items** is rare — only banks' own apps (bunq)
  and specialized expense tools do this.

## Existing-feature feedback (friction found while analyzing)

1. **Overview/insights are period-locked.** "This period" is strong,
   but there's no month-over-month trend view; insights fire rules but
   there's no simple "spending per category over time" chart. Most
   asked-for view in every competitor's reviews.
2. **Budgets don't talk to review.** Confirming a transaction that
   blows a budget is silent; a one-line "Groceries now 92% used" on the
   confirm toast would close the loop.
3. **Goals and allocation overlap conceptually** (both answer "what is
   my unspent money for?"). Long-term: merge into one "money has jobs"
   surface — YNAB's core insight.
4. **Recurring detection exists but subscriptions aren't managed**: no
   price-increase detection ("Netflix went from 13.99 to 15.99"), no
   yearly-total view per subscription. Cheap wins on existing data.
5. **Search is good now (amounts!) but has no saved filters** — e.g.
   "unreviewed + >€50". One chip row remembers the last filter set.
6. **No date-range export.** Users eventually want CSV out; munni can
   read banks but can't be left. An export closes the trust loop
   (aligns with the existing settings.exportData placeholder).
7. **Multi-currency is display-only.** Spaces have one currency;
   accounts in other currencies don't convert in totals. Fine for NL
   focus, but the first TRY account will surface it (user context!).

## Gaps vs other finance apps (what they have, munni doesn't)

| Feature | Who has it | Value for munni | Effort |
|---|---|---|---|
| **Net-worth over time** (all accounts, chart) | Monarch, Copilot, YNAB | High — data already exists (balances + portfolio) | M |
| **Cash-flow forecast** ("safe to spend until salary") | Grip, bunq | High — recurring costs + salary detection exist | M |
| **Subscription price-change alerts** | Rocket Money, Copilot | Medium-high, cheap on existing recurring data | S |
| **Category trends** (per-category monthly bars) | everyone | High | S–M |
| **CSV/Excel export** | everyone | Medium, trust feature | S |
| **Rules engine** ("description contains X → category Y, space Z") | Actual, Monarch | Medium — prediction covers 80%, power users want the last 20 | M |
| **Shared-space settle-up** ("who owes whom", Splitwise-style) | Splitwise, bunq | High for the shared-space audience; reimbursements are halfway there | M–L |
| **Savings buckets / envelopes with auto-rules** ("round up into goal") | bunq, Revolut | Medium; needs write access we deliberately don't have → manual/virtual only | M |
| **Widgets / lock-screen glance** | all native apps | Medium — needs the native shell (see native-apps-design.md) | M after N1 |
| **Attachments beyond receipts** (warranty PDFs, invoices) | Monarch | Low-medium | S |
| **Multi-currency conversion** | YNAB (partial), Revolut | Medium, grows with TRY usage | M |
| **Anomaly alerts** ("this charge is unusual for you") | Copilot | Medium; insights framework can host it | M |

Deliberately NOT recommended: payment initiation (PIS — breaks the
read-only trust model), credit-score views (no NL data source),
crypto-exchange sync (portfolio manual entry suffices), AI chat over
finances (novelty; the insights framework delivers the same value
predictably).

## Recommended shortlist (in order)

1. **Category trends + net-worth chart** — biggest perceived-value per
   effort; both are pure client-side domain work on existing data.
2. **Subscription intelligence** — price-change detection + yearly
   totals on the recurring screen (small).
3. **CSV export** — fills the existing settings placeholder (small).
4. **Cash-flow forecast block on Home** — recurring + salary data
   exists; a "safe until {payday}" number is the single most useful
   personal-finance figure.
5. **Settle-up for shared spaces** — the natural next step after
   reimbursements; makes shared spaces sticky.
6. Saved filters, budget hint on confirm, rules engine — as filler
   slices between bigger arcs.

Each shortlist item should get its own small design note before
implementation (cascade rule).
