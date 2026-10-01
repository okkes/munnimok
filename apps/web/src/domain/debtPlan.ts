import type { AccountRow } from '@/db/types';
import { monthlyPaymentCents } from './debts';

/**
 * The payoff planner's engine (#413, 2026-10-01) — pure, cents, monthly.
 *
 * Three orders decide which debt the spare money hits first:
 *   avalanche — highest interest first (the least interest overall),
 *   snowball  — smallest balance first (the quickest wins),
 *   tsunami   — the debt that weighs on the person most first (relief
 *               first; each debt carries a 1..5 "weighs on you" rank, a
 *               debt without one sits in the middle).
 *
 * Every month: interest accrues on the opening balance, every live debt
 * pays its own minimum, and the pool — the extra per month, the one-off
 * extra in month 1, the minimums of debts already paid off and whatever a
 * capped minimum left over (the rollover every planner assumes) — goes to
 * the first debt of the order that still owes, then the next. The
 * baseline the planner compares against pays the minimums only, nothing
 * rolls over: what happens when nothing changes.
 */

export type PayoffStrategy = 'avalanche' | 'snowball' | 'tsunami';
export const STRATEGIES: readonly PayoffStrategy[] = ['avalanche', 'snowball', 'tsunami'];

/** the "weighs on you" rank a debt carries for the tsunami order (1 light … 5 heavy) */
export type DebtStress = 1 | 2 | 3 | 4 | 5;
export const STRESS_LEVELS: readonly DebtStress[] = [1, 2, 3, 4, 5];
const STRESS_DEFAULT = 3;

export interface PlanDebt {
  id: string;
  name: string;
  /** owed today, positive */
  balanceCents: number;
  /** yearly interest in percent; 0 when unknown */
  aprPct: number;
  /** whether the rate is known at all (an unknown one is counted as 0 and said so) */
  aprKnown: boolean;
  /** the loan's own payment, normalized to a month; 0 when it has none */
  minMonthlyCents: number;
  stress?: DebtStress;
}

export interface PlanOptions {
  strategy: PayoffStrategy;
  /** on top of the minimums, every month */
  extraMonthlyCents?: number;
  /** paid in the first month, once */
  lumpSumCents?: number;
  /** freed minimums and the extra feed the next debt (the planner); off = minimums only (the baseline) */
  rollover?: boolean;
  maxMonths?: number;
}

export interface DebtOutcome {
  id: string;
  /** 1-based month the balance reached zero; null when it never did */
  paidOffMonth: number | null;
  interestCents: number;
  paidCents: number;
  /** position in the payoff order, 1-based */
  order: number;
  /** its own minimum does not cover its monthly interest — at this payment it never shrinks */
  stuck: boolean;
}

export interface PlanResult {
  /** months until every debt is gone; null when the horizon ran out */
  months: number | null;
  totalInterestCents: number;
  totalPaidCents: number;
  /** total owed after each month; index 0 is today */
  balances: number[];
  /** in payoff order */
  debts: DebtOutcome[];
  /** the minimums alone, per month */
  minimumsCents: number;
}

const DEFAULT_HORIZON = 600; // fifty years: beyond that no plan is a plan

const byName = (a: PlanDebt, b: PlanDebt) => a.name.localeCompare(b.name);

/** the debts in the order the spare money reaches them */
export function orderDebts(debts: readonly PlanDebt[], strategy: PayoffStrategy): PlanDebt[] {
  const list = [...debts];
  if (strategy === 'snowball') {
    return list.sort((a, b) => a.balanceCents - b.balanceCents || b.aprPct - a.aprPct || byName(a, b));
  }
  if (strategy === 'tsunami') {
    const stress = (d: PlanDebt) => d.stress ?? STRESS_DEFAULT;
    return list.sort((a, b) => stress(b) - stress(a) || b.aprPct - a.aprPct || a.balanceCents - b.balanceCents || byName(a, b));
  }
  return list.sort((a, b) => b.aprPct - a.aprPct || a.balanceCents - b.balanceCents || byName(a, b));
}

interface Live {
  debt: PlanDebt;
  balance: number;
  interest: number;
  paid: number;
  paidOffMonth: number | null;
}

const monthlyInterest = (balance: number, aprPct: number) => Math.round((balance * aprPct) / 100 / 12);

/** one month's interest on the opening balances and every live debt's own minimum; returns what the minimums leave for the pool */
function accrueAndPayMinimums(live: Live[], rollover: boolean): number {
  let freed = 0;
  for (const l of live) {
    const minimum = Math.max(0, l.debt.minMonthlyCents);
    if (l.balance <= 0) {
      // a debt already gone: its minimum keeps flowing into the plan
      if (rollover) freed += minimum;
      continue;
    }
    const accrued = monthlyInterest(l.balance, l.debt.aprPct);
    l.balance += accrued;
    l.interest += accrued;
    const pay = Math.min(l.balance, minimum);
    l.balance -= pay;
    l.paid += pay;
    if (rollover) freed += minimum - pay;
  }
  return freed;
}

/** the pool hits the first debt of the order that still owes, then the next */
function spendPool(live: Live[], pool: number): void {
  let left = pool;
  for (const l of live) {
    if (left <= 0) break;
    if (l.balance <= 0) continue;
    const pay = Math.min(l.balance, left);
    l.balance -= pay;
    l.paid += pay;
    left -= pay;
  }
}

function markPaidOff(live: Live[], month: number): void {
  for (const l of live) {
    if (l.balance <= 0 && l.paidOffMonth === null) l.paidOffMonth = month;
  }
}

const outcomeOf = (l: Live, index: number): DebtOutcome => ({
  id: l.debt.id,
  paidOffMonth: l.paidOffMonth,
  interestCents: l.interest,
  paidCents: l.paid,
  order: index + 1,
  stuck: l.paidOffMonth === null && Math.max(0, l.debt.minMonthlyCents) <= monthlyInterest(l.debt.balanceCents, l.debt.aprPct),
});

/** walk the months */
export function simulatePlan(debts: readonly PlanDebt[], options: PlanOptions): PlanResult {
  const rollover = options.rollover ?? true;
  const extra = Math.max(0, Math.round(options.extraMonthlyCents ?? 0));
  const lump = Math.max(0, Math.round(options.lumpSumCents ?? 0));
  const horizon = Math.max(1, options.maxMonths ?? DEFAULT_HORIZON);
  const ordered = orderDebts(debts.filter((d) => d.balanceCents > 0), options.strategy);
  const live: Live[] = ordered.map((debt) => ({ debt, balance: debt.balanceCents, interest: 0, paid: 0, paidOffMonth: null }));
  const minimums = ordered.reduce((sum, d) => sum + Math.max(0, d.minMonthlyCents), 0);
  const total = () => live.reduce((sum, l) => sum + l.balance, 0);
  const balances = [total()];
  let month = 0;
  let flat = 0;
  while (total() > 0 && month < horizon) {
    month += 1;
    const before = total();
    const pool = (month === 1 ? lump : 0) + extra + accrueAndPayMinimums(live, rollover);
    spendPool(live, pool);
    markPaidOff(live, month);
    const after = total();
    balances.push(after);
    // nothing shrinks for a year: the payments do not beat the interest — stop pretending
    flat = after >= before ? flat + 1 : 0;
    if (flat >= 12) break;
  }
  return {
    months: total() <= 0 ? month : null,
    totalInterestCents: live.reduce((sum, l) => sum + l.interest, 0),
    totalPaidCents: live.reduce((sum, l) => sum + l.paid, 0),
    balances,
    debts: live.map((l, i) => outcomeOf(l, i)),
    minimumsCents: minimums,
  };
}

/** what happens when nothing changes: minimums only, nothing rolls over */
export const simulateBaseline = (debts: readonly PlanDebt[], maxMonths?: number): PlanResult =>
  simulatePlan(debts, { strategy: 'avalanche', rollover: false, maxMonths });

/** the three orders side by side, same extra */
export function compareStrategies(debts: readonly PlanDebt[], options: Omit<PlanOptions, 'strategy'>): Record<PayoffStrategy, PlanResult> {
  return {
    avalanche: simulatePlan(debts, { ...options, strategy: 'avalanche' }),
    snowball: simulatePlan(debts, { ...options, strategy: 'snowball' }),
    tsunami: simulatePlan(debts, { ...options, strategy: 'tsunami' }),
  };
}

export interface LadderStep {
  /** on top of the current extra */
  moreCents: number;
  months: number | null;
  totalInterestCents: number;
}

/** what a little more per month buys, relative to the plan as it stands */
export function extraLadder(debts: readonly PlanDebt[], options: PlanOptions, moreCents: readonly number[]): LadderStep[] {
  const base = Math.max(0, options.extraMonthlyCents ?? 0);
  return moreCents.map((more) => {
    const r = simulatePlan(debts, { ...options, extraMonthlyCents: base + more });
    return { moreCents: more, months: r.months, totalInterestCents: r.totalInterestCents };
  });
}

/** yyyy-mm of the month `n` months after `today` (yyyy-mm-dd); n = 0 is this month */
export function monthAfter(today: string, n: number): string {
  const [y, m] = today.split('-').map(Number);
  const end = new Date(y, m - 1 + n, 1);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}`;
}

/** the debts the planner works with: the active tracked loans, as the engine sees them */
export function toPlanDebts(loans: readonly { account: AccountRow; remainingCents: number }[]): PlanDebt[] {
  return loans
    .filter(({ account, remainingCents }) => account.archived !== 1 && remainingCents > 0)
    .map(({ account, remainingCents }) => ({
      id: account.id,
      name: account.name,
      balanceCents: remainingCents,
      aprPct: Math.max(0, account.interestPctYear ?? 0),
      aprKnown: account.interestPctYear !== undefined,
      minMonthlyCents: monthlyPaymentCents(account),
      stress: account.debtStress,
    }));
}
