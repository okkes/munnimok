import type { AccountRow } from '@/db/types';
import { monthlyPaymentCents, paymentsPerYear } from './debts';

// payoff engine (#413): pure, cents, monthly; the pool (extra, one-off, freed minimums) feeds the first debt still owing
// baseline = minimums only, no rollover; with the rollover switch off and no extras the plan IS the baseline
// one debt's card is simulateDebtAlone: a change on one debt must never move another's graph

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
  extraMonthlyCents?: number;
  lumpSumCents?: number;
  /** extra aimed at ONE debt by id: paid after its minimum while it owes, outside the order; once gone it feeds the pool */
  extraByDebtCents?: Record<string, number>;
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
  /** every debt's balance per month inside the combined plan, index 0 today (per-debt cards walk their debt alone) */
  balancesByDebt: Record<string, number[]>;
  debts: DebtOutcome[];
  minimumsCents: number;
}

const DEFAULT_HORIZON = 600; // fifty years: beyond that no plan is a plan

const byName = (a: PlanDebt, b: PlanDebt) => a.name.localeCompare(b.name);

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
  extra: number;
}

const monthlyInterest = (balance: number, aprPct: number) => Math.round((balance * aprPct) / 100 / 12);

/** interest on opening balances, then each live debt's minimum + aimed extra; returns what is left for the pool */
function accrueAndPayMinimums(live: Live[], rollover: boolean): number {
  let freed = 0;
  for (const l of live) {
    const own = Math.max(0, l.debt.minMonthlyCents) + l.extra;
    if (l.balance <= 0) {
      // a debt already gone: its minimum and its own extra keep flowing into the plan
      if (rollover) freed += own;
      continue;
    }
    const accrued = monthlyInterest(l.balance, l.debt.aprPct);
    l.balance += accrued;
    l.interest += accrued;
    const pay = Math.min(l.balance, own);
    l.balance -= pay;
    l.paid += pay;
    if (rollover) freed += own - pay;
  }
  return freed;
}

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
  stuck: l.paidOffMonth === null && Math.max(0, l.debt.minMonthlyCents) + l.extra <= monthlyInterest(l.debt.balanceCents, l.debt.aprPct),
});

const ownExtra = (extras: Record<string, number> | undefined, id: string): number => Math.max(0, Math.round(extras?.[id] ?? 0));

export function simulatePlan(debts: readonly PlanDebt[], options: PlanOptions): PlanResult {
  const rollover = options.rollover ?? true;
  const extra = Math.max(0, Math.round(options.extraMonthlyCents ?? 0));
  const lump = Math.max(0, Math.round(options.lumpSumCents ?? 0));
  const horizon = Math.max(1, options.maxMonths ?? DEFAULT_HORIZON);
  const ordered = orderDebts(debts.filter((d) => d.balanceCents > 0), options.strategy);
  const live: Live[] = ordered.map((debt) => ({
    debt,
    balance: debt.balanceCents,
    interest: 0,
    paid: 0,
    paidOffMonth: null,
    extra: ownExtra(options.extraByDebtCents, debt.id),
  }));
  const minimums = ordered.reduce((sum, d) => sum + Math.max(0, d.minMonthlyCents), 0);
  const total = () => live.reduce((sum, l) => sum + l.balance, 0);
  const balances = [total()];
  const balancesByDebt: Record<string, number[]> = Object.fromEntries(live.map((l) => [l.debt.id, [l.balance]]));
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
    for (const l of live) balancesByDebt[l.debt.id].push(l.balance);
    // nothing shrinks for a year: the payments do not beat the interest — stop pretending
    flat = after >= before ? flat + 1 : 0;
    if (flat >= 12) break;
  }
  return {
    months: total() <= 0 ? month : null,
    totalInterestCents: live.reduce((sum, l) => sum + l.interest, 0),
    totalPaidCents: live.reduce((sum, l) => sum + l.paid, 0),
    balances,
    balancesByDebt,
    debts: live.map((l, i) => outcomeOf(l, i)),
    minimumsCents: minimums,
  };
}

export const simulateBaseline = (debts: readonly PlanDebt[], maxMonths?: number): PlanResult =>
  simulatePlan(debts, { strategy: 'avalanche', rollover: false, maxMonths });

export interface AloneResult {
  balances: number[];
  months: number | null;
  interestCents: number;
  paidCents: number;
  stuck: boolean;
  monthlyCents: number;
}

/** minimum + aimed extra only, no pool or freed minimums: a change on one debt never moves another's card */
export function simulateDebtAlone(debt: PlanDebt, extraMonthlyCents = 0, maxMonths?: number): AloneResult {
  const extra = Math.max(0, Math.round(extraMonthlyCents));
  const r = simulatePlan([debt], { strategy: 'avalanche', rollover: false, extraByDebtCents: { [debt.id]: extra }, maxMonths });
  return {
    balances: r.balances,
    months: r.months,
    interestCents: r.totalInterestCents,
    paidCents: r.totalPaidCents,
    stuck: r.debts[0]?.stuck ?? false,
    monthlyCents: Math.max(0, debt.minMonthlyCents) + extra,
  };
}

export interface RaisedPayment {
  paymentCents: number;
  extraCents: number;
  /** payments a year — 12 is monthly, where the extra needs no converting */
  perYear: number;
}

// "Apply to the loan": the monthly extra is converted to the loan's stored cadence (€50 a month = €11.54 a week);
// a loan without a stored payment gets the extra as its payment
export function raisedPayment(loan: Pick<AccountRow, 'paymentCents' | 'paymentEvery' | 'paymentEveryN'>, extraMonthlyCents: number): RaisedPayment {
  const perYear = paymentsPerYear(loan.paymentEvery, loan.paymentEveryN);
  const extraCents = Math.max(0, Math.round((Math.max(0, extraMonthlyCents) * 12) / perYear));
  return { paymentCents: Math.max(0, loan.paymentCents ?? 0) + extraCents, extraCents, perYear };
}

export function compareStrategies(debts: readonly PlanDebt[], options: Omit<PlanOptions, 'strategy'>): Record<PayoffStrategy, PlanResult> {
  return {
    avalanche: simulatePlan(debts, { ...options, strategy: 'avalanche' }),
    snowball: simulatePlan(debts, { ...options, strategy: 'snowball' }),
    tsunami: simulatePlan(debts, { ...options, strategy: 'tsunami' }),
  };
}

export interface LadderStep {
  moreCents: number;
  months: number | null;
  totalInterestCents: number;
}

export function extraLadder(debts: readonly PlanDebt[], options: PlanOptions, moreCents: readonly number[]): LadderStep[] {
  const base = Math.max(0, options.extraMonthlyCents ?? 0);
  return moreCents.map((more) => {
    const r = simulatePlan(debts, { ...options, extraMonthlyCents: base + more });
    return { moreCents: more, months: r.months, totalInterestCents: r.totalInterestCents };
  });
}

export function monthAfter(today: string, n: number): string {
  const [y, m] = today.split('-').map(Number);
  const end = new Date(y, m - 1 + n, 1);
  return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}`;
}

const CHART_POINTS = 120;
/** the months past the plan's end, so the landing reads as a landing and not a wall */
const HORIZON_ROOM = 6;
/** a minimums line ending within this many plan horizons shares the plan's even scale */
const EVEN_REACH = 3;
/** the share of the width the plan's even scale keeps when a compressed tail follows */
export const FOCUS_SHARE = 0.72;
const YEAR_STRIDES: readonly number[] = [1, 2, 5, 10, 20, 50];
const MONTH_STRIDES: readonly number[] = [1, 2, 3, 6];
export const MONTH_TICKS_BELOW = 24;
const TAIL_MID_FROM = 120;

// #513: the axis always runs to where the minimums line ends; within three plan horizons it stays even, further out the
// plan's months take most of the width and the rest follows on a compressed tail with its own year marks
export interface ChartAxis {
  focusMonths: number;
  /** where the axis ends; past focusMonths the tail is compressed */
  totalMonths: number;
}

export function chartAxis(planMonths: number, baselineMonths: number): ChartAxis {
  const plan = Math.max(0, planMonths);
  const base = Math.max(0, baselineMonths);
  const focus = Math.max(1, plan + HORIZON_ROOM);
  const total = Math.max(focus, base);
  return total <= focus * EVEN_REACH ? { focusMonths: total, totalMonths: total } : { focusMonths: focus, totalMonths: total };
}

export const hasTail = (axis: ChartAxis): boolean => axis.totalMonths > axis.focusMonths;

export function axisFraction(axis: ChartAxis, month: number): number {
  const m = Math.min(Math.max(0, month), axis.totalMonths);
  if (!hasTail(axis)) return axis.totalMonths > 0 ? m / axis.totalMonths : 0;
  if (m <= axis.focusMonths) return (m / axis.focusMonths) * FOCUS_SHARE;
  return FOCUS_SHARE + ((m - axis.focusMonths) / (axis.totalMonths - axis.focusMonths)) * (1 - FOCUS_SHARE);
}

export interface WalkPoint {
  month: number;
  value: number;
}

/** a walk that pays off ends where it lands (#513); one that never does holds its last value to the axis end */
export function sampleWalk(values: readonly number[], landed: boolean, axis: ChartAxis): WalkPoint[] {
  if (values.length === 0) return [];
  const end = landed ? Math.min(values.length - 1, axis.totalMonths) : axis.totalMonths;
  const tail = hasTail(axis);
  const focusStep = Math.max(1, Math.ceil(axis.focusMonths / (CHART_POINTS * (tail ? FOCUS_SHARE : 1))));
  const tailStep = Math.max(1, Math.ceil((axis.totalMonths - axis.focusMonths) / (CHART_POINTS * (1 - FOCUS_SHARE))));
  const months: number[] = [];
  for (let month = 0; month < Math.min(end, axis.focusMonths); month += focusStep) months.push(month);
  for (let month = axis.focusMonths; month < end; month += tailStep) months.push(month);
  months.push(end);
  const last = values.at(-1) ?? 0;
  return months.map((month) => ({ month, value: month < values.length ? values[month] : last }));
}

export interface ChartTick {
  month: number;
  label: string;
}

/** the marks every `stride` months from the start; never two within an eighth of the span of each other */
function marksEvery(totalMonths: number, stride: number, maxTicks: number, label: (month: number) => string): ChartTick[] {
  const minGap = Math.max(1, Math.ceil(totalMonths / 8));
  const ticks: ChartTick[] = [];
  for (let month = 0; month <= totalMonths && ticks.length < maxTicks; month += stride) {
    const prev = ticks.at(-1);
    if (prev && month - prev.month < minGap) continue;
    ticks.push({ month, label: label(month) });
  }
  return ticks;
}

// year marks stand where their year BEGINS (#513: a mark at today's month put a June payoff left of its own year's label);
// round years, the smallest stride that keeps at most maxTicks
export function yearTicks(totalMonths: number, today: string, maxTicks = 6): ChartTick[] {
  const months = Math.max(0, totalMonths);
  const [year, month] = today.split('-').map(Number);
  const januaries: { month: number; year: number }[] = [];
  for (let at = (13 - month) % 12; at <= months; at += 12) januaries.push({ month: at, year: year + (at + month - 1) / 12 });
  const stride = YEAR_STRIDES.find((years) => januaries.filter((jan) => jan.year % years === 0).length <= maxTicks) ?? YEAR_STRIDES.at(-1) ?? 1;
  const marks = januaries.filter((jan) => jan.year % stride === 0).map((jan) => ({ month: jan.month, label: String(jan.year) }));
  const minGap = Math.max(1, Math.ceil(months / 8));
  const start = marks.length === 0 || marks[0].month >= minGap ? [{ month: 0, label: String(year) }] : [];
  return [...start, ...marks].filter((tick, i, all) => i === 0 || tick.month - all[i - 1].month >= minGap);
}

// month marks for a short horizon (year marks say nothing about a nine-month plan); labels are yyyy-mm
export function monthTicks(totalMonths: number, today: string, maxTicks = 6): ChartTick[] {
  const months = Math.max(0, totalMonths);
  const stride = MONTH_STRIDES.find((n) => Math.floor(months / n) + 1 <= maxTicks) ?? MONTH_STRIDES.at(-1) ?? 1;
  return marksEvery(months, stride, maxTicks, (month) => monthAfter(today, month));
}

export function axisTicks(axis: ChartAxis, today: string): ChartTick[] {
  const room = hasTail(axis) ? 4 : 6;
  const even = axis.focusMonths < MONTH_TICKS_BELOW ? monthTicks(axis.focusMonths, today, room) : yearTicks(axis.focusMonths, today, room);
  if (!hasTail(axis)) return even;
  const span = axis.totalMonths - axis.focusMonths;
  const yearAt = (month: number): ChartTick => ({ month, label: monthAfter(today, month).slice(0, 4) });
  const firstJanuary = (13 - Number(today.slice(5, 7))) % 12;
  const middleJanuary = firstJanuary + 12 * Math.round((axis.focusMonths + span / 2 - firstJanuary) / 12);
  const middle = span >= TAIL_MID_FROM ? [yearAt(middleJanuary)] : [];
  return [...even, ...middle, yearAt(axis.totalMonths)];
}

export function monthsUntil(today: string, yyyymm: string): number {
  const [y, m] = today.split('-').map(Number);
  const [ty, tm] = yyyymm.split('-').map(Number);
  return (ty - y) * 12 + (tm - m);
}

// more extra never ends later: a halving search finds the smallest whole-euro extra; null when the month is already here
function smallestExtra(endsBy: (extraCents: number) => number | null, targetMonths: number, ceilingCents: number): number | null {
  if (targetMonths < 1) return null;
  const done = (extraCents: number) => {
    const months = endsBy(extraCents);
    return months !== null && months <= targetMonths;
  };
  if (done(0)) return 0;
  let high = Math.max(1, Math.ceil(ceilingCents / 100));
  if (!done(high * 100)) return null;
  let low = 0;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    if (done(mid * 100)) high = mid;
    else low = mid;
  }
  return high * 100;
}

/** everything owed plus a month of interest: paid as one extra, any walk ends in its first month */
const ceilingOf = (debts: readonly PlanDebt[]): number =>
  debts.reduce((sum, d) => sum + Math.max(0, d.balanceCents) + monthlyInterest(Math.max(0, d.balanceCents), d.aprPct), 0);

/** #514: the extra one debt needs, walked alone, to be paid off by then */
export const extraForDebtBy = (debt: PlanDebt, targetMonths: number): number | null =>
  smallestExtra((extra) => simulateDebtAlone(debt, extra).months, targetMonths, ceilingOf([debt]));

export const extraForPlanBy = (debts: readonly PlanDebt[], options: PlanOptions, targetMonths: number): number | null =>
  smallestExtra((extra) => simulatePlan(debts, { ...options, extraMonthlyCents: extra }).months, targetMonths, ceilingOf(debts));

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
