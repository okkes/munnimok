import type { BudgetRow, SpacePeriodType, TxView, WeekStart } from '@/db/types';
import { txSliceViews } from './txSlices';
import type { Period } from './periods';
import { nextPeriod } from './periods';

/**
 * Budget math, all pure (budgets design doc, approved 2026-07-09):
 * spending counts a budget's category family's expenses inside the
 * budget's own anchored period; carry-over is REPLAYED from history —
 * never stored — so every device computes the same numbers.
 */

const DAY_MS = 86_400_000;
// replay guard: weekly budgets anchored years back stay bounded
const MAX_REPLAY_PERIODS = 260;

const localIso = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parse = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const shiftDays = (d: Date, days: number): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** the space facts a budget's cycle depends on: the week's first day (weekly cadences) and the space period ('period' cadence) */
export interface BudgetPeriodOpts {
  weekStart?: WeekStart;
  spacePeriod?: { periodType: SpacePeriodType; periodDay: number };
}
/** the options every budget call derives from the space row (no space = Monday, monthly from the 1st) */
export const budgetOptsFor = (
  space: { weekStart?: WeekStart; periodType: SpacePeriodType; periodDay: number } | null | undefined,
): BudgetPeriodOpts => (space ? { weekStart: space.weekStart, spacePeriod: { periodType: space.periodType, periodDay: space.periodDay } } : {});

const MAX_CYCLES = 2000;
/** day `day` of the month `m` of year `y`, clamped into short months (31st → Feb 28) */
const dayOfMonth = (y: number, m: number, day: number): Date => {
  const first = new Date(y, m, 1);
  const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  return new Date(first.getFullYear(), first.getMonth(), Math.min(day, lastDay));
};
/** the first date on/after `d` that falls on the week's first day */
const weekStartOnOrAfter = (d: Date, weekStart: WeekStart): Date => {
  const target = weekStart === 'sunday' ? 0 : 1;
  return shiftDays(d, (target - d.getDay() + 7) % 7);
};
/** the first reset on/after `d` for a monthly budget resetting on `day` */
const monthResetOnOrAfter = (d: Date, day: number): Date => {
  const inMonth = dayOfMonth(d.getFullYear(), d.getMonth(), day);
  return inMonth >= d ? inMonth : dayOfMonth(d.getFullYear(), d.getMonth() + 1, day);
};
/** the start of the space period that follows the one containing `d` */
const spacePeriodStartAfter = (d: Date, sp: NonNullable<BudgetPeriodOpts['spacePeriod']>): Date =>
  parse(nextPeriod(sp.periodType, sp.periodDay, d).start);

/**
 * The start of cycle `index`. Cycle 0 opens on the start date and runs
 * until the first reset after it — so it may be partial: a monthly budget
 * started mid-month resets on its reset day (#371), a weekly one on the
 * space's first weekday (#370); every later cycle is a full one. A weekly
 * budget that STARTS on the week's first day keeps whole weeks from day
 * one. 'period' follows the space's own budget period (#369).
 */
function cycleStart(budget: BudgetRow, index: number, opts: BudgetPeriodOpts): Date {
  const anchor = parse(budget.anchor);
  if (index <= 0) return anchor;
  const weekStart = opts.weekStart ?? 'monday';
  const sp = opts.spacePeriod ?? { periodType: 'month' as SpacePeriodType, periodDay: 1 };
  const len = budget.every === 'week' ? 7 : 14;
  const resetDay = budget.resetDay ?? anchor.getDate();
  let start: Date;
  if (budget.every === 'month') start = monthResetOnOrAfter(shiftDays(anchor, 1), resetDay);
  else if (budget.every === 'period') start = spacePeriodStartAfter(anchor, sp);
  else {
    const aligned = weekStartOnOrAfter(anchor, weekStart);
    start = aligned.getTime() === anchor.getTime() ? shiftDays(anchor, len) : aligned;
  }
  for (let i = 1; i < index; i += 1) {
    if (budget.every === 'month') start = dayOfMonth(start.getFullYear(), start.getMonth() + 1, resetDay);
    else if (budget.every === 'period') start = spacePeriodStartAfter(start, sp);
    else start = shiftDays(start, len);
  }
  return start;
}

/** the budget's period at cycle `index` (0 = the period the start date opens) */
export function budgetPeriodAt(budget: BudgetRow, index: number, opts: BudgetPeriodOpts = {}): Period {
  const i = Math.max(0, index);
  return { start: localIso(cycleStart(budget, i, opts)), end: localIso(shiftDays(cycleStart(budget, i + 1, opts), -1)) };
}

/** how many whole cycles lie between the start date and `today` */
export function cycleIndex(budget: BudgetRow, today: string, opts: BudgetPeriodOpts = {}): number {
  const now = parse(today);
  if (now < parse(budget.anchor)) return 0;
  for (let index = 0; index < MAX_CYCLES; index += 1) {
    if (now < cycleStart(budget, index + 1, opts)) return index;
  }
  return MAX_CYCLES;
}

/** the period containing `today` (or the start date's period before it opens) */
export const currentBudgetPeriod = (budget: BudgetRow, today: string, opts: BudgetPeriodOpts = {}): Period =>
  budgetPeriodAt(budget, cycleIndex(budget, today, opts), opts);

/** whole days until the cycle resets, today included (list/home/detail) */
export const budgetDaysLeft = (budget: BudgetRow, today: string, opts: BudgetPeriodOpts = {}): number =>
  Math.max(0, Math.round((Date.parse(currentBudgetPeriod(budget, today, opts).end) - Date.parse(today)) / DAY_MS)) + 1;

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
  childrenOf: (id: string) => { id: string }[];
}

/** the ids a budget's categories claim: each main claims all its subs */
export function budgetFamily(catIds: readonly string[], catalog: CatalogLookup): Set<string> {
  return new Set(catIds.flatMap((id) => [id, ...catalog.childrenOf(id).map((c) => c.id)]));
}

/** positive cents spent by the family inside a period (refunds reduce it).
 *  Slice-aware (reimbursement redesign; typed-splits v2): a split
 *  transaction contributes only its family slices, so reimbursed value
 *  never counts as spending — and a typed part answers to its OWN kind
 *  (a loan part inside the phone bill never eats the telecom budget). */
export function budgetSpentCents(
  txs: readonly TxView[],
  family: ReadonlySet<string>,
  period: Period,
): number {
  let total = 0;
  for (const tx of txs) {
    if (tx.deleted !== 0) continue;
    if (tx.date < period.start || tx.date > period.end) continue;
    for (const view of txSliceViews(tx)) {
      if (view.effType !== 'expense' || !family.has(view.catId ?? '')) continue;
      // whole-row views (a category spread included, #211) contribute
      // SIGNED — refunds keep reducing spend; parts are magnitudes
      total += view.fromParts ? Math.abs(view.amountCents) : -view.amountCents;
    }
  }
  return total;
}

/**
 * Unused money rolled into the current period. Replayed from history:
 * mode 'periods' looks back at most N cycles; mode 'cap' replays the
 * whole (bounded) history but never accumulates beyond the cap.
 */
export function carriedCents(
  budget: BudgetRow,
  txs: readonly TxView[],
  family: ReadonlySet<string>,
  today: string,
  opts: BudgetPeriodOpts = {},
): number {
  if (budget.carryOver !== 1) return 0;
  const current = cycleIndex(budget, today, opts);
  if (current <= 0) return 0;

  const window =
    budget.carryMode === 'periods'
      ? Math.min(current, Math.max(1, budget.carryPeriods ?? 1))
      : Math.min(current, MAX_REPLAY_PERIODS);
  const cap = budget.carryMode === 'cap' ? Math.max(0, budget.carryCapCents ?? 0) : Number.POSITIVE_INFINITY;

  let carried = 0;
  for (let index = current - window; index < current; index++) {
    const spent = budgetSpentCents(txs, family, budgetPeriodAt(budget, index, opts));
    const leftover = budget.amountCents + carried - spent;
    carried = Math.min(Math.max(leftover, 0), cap);
  }
  return carried;
}

export interface BudgetStatus {
  budget: BudgetRow;
  period: Period;
  spentCents: number;
  carriedCents: number;
  /** amount + carried */
  limitCents: number;
  /** limit − spent (negative = over) */
  leftCents: number;
  /** spent / limit; 0 when the limit is 0 */
  ratio: number;
}

export function budgetStatus(
  budget: BudgetRow,
  txs: readonly TxView[],
  catalog: CatalogLookup,
  today: string,
  opts: BudgetPeriodOpts = {},
): BudgetStatus {
  const family = budgetFamily(budget.catIds, catalog);
  const period = currentBudgetPeriod(budget, today, opts);
  const carried = carriedCents(budget, txs, family, today, opts);
  const spent = budgetSpentCents(txs, family, period);
  const limit = budget.amountCents + carried;
  return {
    budget,
    period,
    spentCents: spent,
    carriedCents: carried,
    limitCents: limit,
    leftCents: limit - spent,
    ratio: limit > 0 ? spent / limit : 0,
  };
}

/** over-budget first (worst ratio), then closest to the limit */
export const sortByUrgency = (statuses: readonly BudgetStatus[]): BudgetStatus[] =>
  [...statuses].sort((a, b) => b.ratio - a.ratio);

/**
 * Category exclusivity (per space): a category may live in one budget.
 * Returns, for each candidate id, the name of the budget already
 * claiming it (directly or via the main↔sub family) — the picker
 * disables those with a badge naming the owner.
 */
export function categoryConflicts(
  candidates: readonly string[],
  otherBudgets: readonly BudgetRow[],
  catalog: CatalogLookup,
): Map<string, string> {
  const conflicts = new Map<string, string>();
  const families = otherBudgets.map((b) => ({ name: b.name, family: budgetFamily(b.catIds, catalog) }));
  for (const id of candidates) {
    const own = budgetFamily([id], catalog);
    const owner = families.find((f) => [...own].some((member) => f.family.has(member)));
    if (owner) conflicts.set(id, owner.name);
  }
  return conflicts;
}
