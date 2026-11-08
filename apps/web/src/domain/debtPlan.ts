import type { AccountRow } from '@/db/types';
import { monthlyPaymentCents, paymentsPerYear } from './debts';

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
 * rolls over: what happens when nothing changes. The rollover is a
 * switch on the screen (user 2026-10-09: "I haven't made any change and
 * yet somehow it differs from minimums — why is it being paid
 * instantly?"): off, with no extras, the plan IS the baseline.
 *
 * A single debt's own picture comes from simulateDebtAlone: that debt
 * walked by itself, nothing from the others (user 2026-10-09: "when I
 * change one, it impacts the other graphs — that should not happen").
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
  /**
   * an extra per month aimed at ONE debt, by id (user 2026-10-08: "if I
   * finetune the payment of a specific debt, I want to see the impact"):
   * paid to that debt right after its minimum every month while it owes,
   * outside the order; once the debt is gone it feeds the pool like a
   * freed minimum (with the rollover)
   */
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
  /**
   * every debt's balance after each month, by id, index 0 today — how
   * each debt fares INSIDE the combined plan (the per-debt cards do not
   * read this since 2026-10-09: they walk their debt alone)
   */
  balancesByDebt: Record<string, number[]>;
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
  /** the extra per month aimed at this debt alone, on top of its minimum */
  extra: number;
}

const monthlyInterest = (balance: number, aprPct: number) => Math.round((balance * aprPct) / 100 / 12);

/**
 * one month's interest on the opening balances, then every live debt's
 * own payment — its minimum and the extra aimed at it; returns what those
 * payments leave for the pool (a capped payment's remainder, and the
 * whole payment of a debt already gone)
 */
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
  stuck: l.paidOffMonth === null && Math.max(0, l.debt.minMonthlyCents) + l.extra <= monthlyInterest(l.debt.balanceCents, l.debt.aprPct),
});

/** the extra aimed at one debt, as cents or nothing */
const ownExtra = (extras: Record<string, number> | undefined, id: string): number => Math.max(0, Math.round(extras?.[id] ?? 0));

/** walk the months */
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

/** what happens when nothing changes: minimums only, nothing rolls over */
export const simulateBaseline = (debts: readonly PlanDebt[], maxMonths?: number): PlanResult =>
  simulatePlan(debts, { strategy: 'avalanche', rollover: false, maxMonths });

/** one debt walked by itself */
export interface AloneResult {
  /** its balance after each month, index 0 today */
  balances: number[];
  /** 1-based month it reached zero; null when it never did */
  months: number | null;
  interestCents: number;
  paidCents: number;
  /** its payment does not beat its interest — it never shrinks */
  stuck: boolean;
  /** what it pays per month: its minimum and the extra aimed at it */
  monthlyCents: number;
}

/**
 * one debt on its own (user 2026-10-09: "the individual loan … should
 * only focus on itself"): its minimum plus the extra aimed at it, every
 * month, nothing else — no strategy pool, no freed minimum of another
 * debt rolling in — so a change on one debt never moves another's card;
 * the combined plan (simulatePlan) is where the debts meet
 */
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

/** a loan's payment raised by a monthly extra, in the loan's own cadence */
export interface RaisedPayment {
  /** the payment to store: what it is now plus the extra per payment */
  paymentCents: number;
  /** the monthly extra as an amount per payment of the loan's cadence */
  extraCents: number;
  /** payments a year — 12 is monthly, where the extra needs no converting */
  perYear: number;
}

/**
 * "Apply to the loan" (user 2026-10-09): the extra the planner counts
 * per month lands on the loan's stored payment, which is per week, month
 * or year (paymentEvery × paymentEveryN) — a €50-a-month extra on a
 * weekly payer is €11.54 a week; a loan without a stored payment gets
 * the extra as its payment
 */
export function raisedPayment(loan: Pick<AccountRow, 'paymentCents' | 'paymentEvery' | 'paymentEveryN'>, extraMonthlyCents: number): RaisedPayment {
  const perYear = paymentsPerYear(loan.paymentEvery, loan.paymentEveryN);
  const extraCents = Math.max(0, Math.round((Math.max(0, extraMonthlyCents) * 12) / perYear));
  return { paymentCents: Math.max(0, loan.paymentCents ?? 0) + extraCents, extraCents, perYear };
}

/** the three orders side by side, same extras (the per-debt ones included) */
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

/** what a little more per month buys, relative to the plan as it stands (its per-debt extras stay in) */
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

/* ── the chart's axis ──────────────────────────────────────────────── */

/** at most this many points per line: the chart stays light, the paths short */
const CHART_POINTS = 120;
/** the months past the plan's end, so the landing reads as a landing and not a wall */
const HORIZON_ROOM = 6;
/** a minimums line ending within this many plan horizons shares the plan's even scale */
const EVEN_REACH = 3;
/** the share of the width the plan's even scale keeps when a compressed tail follows */
export const FOCUS_SHARE = 0.72;
/** the year strides a chart may label by — the smallest that keeps the labels apart wins */
const YEAR_STRIDES: readonly number[] = [1, 2, 5, 10, 20, 50];
/** the month strides for a horizon too short for years */
const MONTH_STRIDES: readonly number[] = [1, 2, 3, 6];
/** under this many months a chart labels months, not years */
export const MONTH_TICKS_BELOW = 24;
/** a tail of at least this many months gets a year mark in its middle as well */
const TAIL_MID_FROM = 120;

/**
 * A payoff chart's time axis (#513, user: "always show the end point of
 * the minimum line … represent the years a bit better"). The plan keeps
 * an even scale with room past its end (2026-10-08: a short plan against
 * a thirty-year minimums line was a cliff at the left edge); the axis then
 * always runs on to where the minimums line ends. When that end lies
 * within three plan horizons the whole axis stays even; further out, the
 * plan's months take most of the width and the remaining years follow on
 * a compressed tail — broken on the axis, its own year marks under it.
 */
export interface ChartAxis {
  /** the months on the even scale, from today */
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

/** the axis carries a compressed tail */
export const hasTail = (axis: ChartAxis): boolean => axis.totalMonths > axis.focusMonths;

/** where a month sits across the axis, 0 … 1 */
export function axisFraction(axis: ChartAxis, month: number): number {
  const m = Math.min(Math.max(0, month), axis.totalMonths);
  if (!hasTail(axis)) return axis.totalMonths > 0 ? m / axis.totalMonths : 0;
  if (m <= axis.focusMonths) return (m / axis.focusMonths) * FOCUS_SHARE;
  return FOCUS_SHARE + ((m - axis.focusMonths) / (axis.totalMonths - axis.focusMonths)) * (1 - FOCUS_SHARE);
}

/** one sample of a walk on the axis */
export interface WalkPoint {
  month: number;
  value: number;
}

/**
 * A walk sampled onto the axis — finer on the even scale than on the tail,
 * within the point budget. A walk that pays off ends where it lands (#513,
 * user: "the green line should stop after … it's done paying"); one that
 * never does holds its last value to the axis end.
 */
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
  /** the month from today the label sits under */
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

/**
 * year marks (user 2026-10-08: every sampled year got a label and they
 * overlapped): each mark stands where its year BEGINS (#513: a mark at
 * today's month each year put a June payoff left of its own year's
 * label), on round years — every year, every second, fifth or tenth, the
 * smallest stride that keeps at most `maxTicks` of them — and the start
 * names this year when it stands clear of the first mark
 */
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

/**
 * month marks for a short horizon (a year mark or two says nothing about
 * a nine-month plan): every 1, 2, 3 or 6 months from the start; the label
 * is that month as yyyy-mm, for the screen to word in the person's language
 */
export function monthTicks(totalMonths: number, today: string, maxTicks = 6): ChartTick[] {
  const months = Math.max(0, totalMonths);
  const stride = MONTH_STRIDES.find((n) => Math.floor(months / n) + 1 <= maxTicks) ?? MONTH_STRIDES.at(-1) ?? 1;
  return marksEvery(months, stride, maxTicks, (month) => monthAfter(today, month));
}

/**
 * The axis's labels: months or years over the even scale (fewer when a
 * tail shares the width), and on a tail the year it ends in — with a year
 * near its middle too (where that year begins) when it spans ten years or
 * more. Month labels come as yyyy-mm, years as yyyy.
 */
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

/* ── an end date instead of an amount (#514) ──────────────────────── */

/** the whole months from today's month to a yyyy-mm (0 = this month) */
export function monthsUntil(today: string, yyyymm: string): number {
  const [y, m] = today.split('-').map(Number);
  const [ty, tm] = yyyymm.split('-').map(Number);
  return (ty - y) * 12 + (tm - m);
}

/**
 * the smallest extra per month, in whole euros, that ends a walk within
 * `targetMonths` — 0 when it already does; null when no amount can (a
 * month already here). More extra never ends later, so a halving search
 * over [0, ceiling] finds it in a handful of walks.
 */
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

/** #514 (user: "provide an end date and get the calculation"): the extra one debt needs, walked alone, to be paid off by then */
export const extraForDebtBy = (debt: PlanDebt, targetMonths: number): number | null =>
  smallestExtra((extra) => simulateDebtAlone(debt, extra).months, targetMonths, ceilingOf([debt]));

/** the extra per month the combined plan needs, its other settings kept, to be debt-free by then */
export const extraForPlanBy = (debts: readonly PlanDebt[], options: PlanOptions, targetMonths: number): number | null =>
  smallestExtra((extra) => simulatePlan(debts, { ...options, extraMonthlyCents: extra }).months, targetMonths, ceilingOf(debts));

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
