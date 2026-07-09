# Goals — design

Status: **approved 2026-07-09** — ready to build.
Legacy `apps/legacy` goals screens are the inspiration (allocation
rings, per-goal target/date), rebuilt on synced data.

## The idea

A **goal** is something you're saving toward — a house deposit, a car,
a buffer. You fund goals by **allocating money you already saved**:
the app never moves real money, it partitions your savings balance into
named envelopes so "what is this €12k actually for?" has an answer.

## Data model

```
goal (synced, per space) {
  id, spaceId, name, icon, color?,
  targetCents,
  targetDate?,                 // optional deadline
  allocatedCents,              // running total, updated by contributions
  archived?: 0 | 1             // reached/abandoned
}
goalContribution (synced, per space) {
  id, spaceId, goalId,
  amountCents,                 // + fund / − withdraw
  date, note?
}
```

`allocatedCents` is derived-but-stored for cheap lists; contributions
are the audit trail (and make two-device edits converge naturally —
concurrent contributions are separate rows, no LWW fight over a sum).

## The honesty check

Goals live against **savings-type accounts**. The goals screen shows:

> Saved total (savings accounts) €14,200 · allocated €11,000 ·
> **unallocated €3,200**

Over-allocation (allocated > actual savings) is allowed but flagged
amber — the plan got ahead of reality.

## UX

1. **Goals screen** (Settings → This space → Goals): unallocated header
   line, goal cards — icon, name, progress ring/bar
   (allocated/target), "€X to go", deadline chip with the required
   per-month pace when dated (`(target − allocated) / months left`).
2. **Goal detail**: big progress, pace line ("€250/mo keeps you on
   track for Jun 2027"), contribution list, +Fund / −Withdraw sheet
   (amount + optional note; withdraw returns to unallocated).
3. **Home block** (customizer-pluggable): top goal by proximity to its
   deadline pace, one progress bar.
4. Reaching 100%: confetti-free celebration row + archive prompt.

## Rollout

- **G1** — entities + goals screen + fund/withdraw + unallocated math.
- **G2** — detail + pace/deadline logic + home block.
- Tests: allocation arithmetic, over-allocation flag, pace math,
  concurrent contributions converge.

## Confirmed rulings (2026-07-09)

1. Goals are per space — a shared "house" goal in a shared space is
   natural. ✓
2. No transaction linking at all — the savings BALANCE is the only
   truth. When a withdrawal drops the saved total below what's
   allocated, **unallocated goes negative** and the user must remove
   value from goals to rebalance; the app flags it, never auto-fixes. ✓
