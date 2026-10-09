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

/* ── the chart's grid ──────────────────────────────────────────────── */

/** at most this many points per line: the chart stays light, the paths short */
const CHART_POINTS = 120;
/** the months past the plan's end, so the landing reads as a landing and not a wall */
const HORIZON_ROOM = 6;
/** the year strides a chart may label by — the smallest that keeps the labels apart wins */
const YEAR_STRIDES: readonly number[] = [1, 2, 5, 10, 20, 50];
/** the month strides for a horizon too short for years */
const MONTH_STRIDES: readonly number[] = [1, 2, 3, 6];
/** under this many months a chart labels months, not years */
export const MONTH_TICKS_BELOW = 24;

/**
 * the months a payoff chart spans (user 2026-10-08: "if I drag to the
 * max" the plan was a cliff at the left edge, because the x-axis still
 * spanned the thirty-year minimums-only walk): the plan's own length
 * with room — six months past its end at least, up to three times its
 * length when the minimums run that long — never past the longer walk
 */
export function chartHorizon(planMonths: number, baselineMonths: number): number {
  const plan = Math.max(0, planMonths);
  const base = Math.max(0, baselineMonths);
  const wanted = Math.max(plan + HORIZON_ROOM, Math.min(base, plan * 3));
  return Math.max(1, Math.min(wanted, Math.max(base, plan)));
}

/** the months between two chart samples, so a horizon fits the point budget */
export const sampleStep = (horizonMonths: number): number => Math.max(1, Math.ceil(horizonMonths / CHART_POINTS));

/**
 * a walk on the chart's grid: one value every `step` months from today up
 * to the horizon; past the walk's end its last value holds — a paid-off
 * debt stays at zero, a stalled one where it stalled
 */
export function sampleMonths(values: readonly number[], step: number, horizonMonths: number): number[] {
  if (values.length === 0) return [];
  const grid = Math.max(1, step);
  const last = values.at(-1) ?? 0;
  const out: number[] = [];
  for (let month = 0; month <= horizonMonths; month += grid) out.push(month < values.length ? values[month] : last);
  return out;
}

export interface ChartTick {
  /** the grid index (the sample) the label sits under */
  index: number;
  label: string;
}

/** the marks every `stride` months from the start, each at its nearest sample; never two within an eighth of the width of each other */
function marksEvery(totalMonths: number, step: number, stride: number, maxTicks: number, label: (month: number) => string): ChartTick[] {
  const grid = Math.max(1, step);
  const minGap = Math.max(1, Math.ceil(Math.floor(totalMonths / grid) / 8));
  const ticks: ChartTick[] = [];
  for (let month = 0; month <= totalMonths && ticks.length < maxTicks; month += stride) {
    const index = Math.round(month / grid);
    const prev = ticks.at(-1);
    if (prev && index - prev.index < minGap) continue;
    ticks.push({ index, label: label(month) });
  }
  return ticks;
}

/**
 * year marks on the sampled grid (user 2026-10-08: every sampled year got
 * a label and they overlapped): the start, then every 1, 2, 5 or 10 years
 * from it — the smallest stride that keeps at most `maxTicks` labels; the
 * label is the year of that mark
 */
export function yearTicks(totalMonths: number, step: number, today: string, maxTicks = 6): ChartTick[] {
  const months = Math.max(0, totalMonths);
  const stride = YEAR_STRIDES.find((years) => Math.floor(months / (12 * years)) + 1 <= maxTicks) ?? YEAR_STRIDES.at(-1) ?? 1;
  const year = Number(today.slice(0, 4));
  return marksEvery(months, step, 12 * stride, maxTicks, (month) => String(year + month / 12));
}

/**
 * month marks for a short horizon (a year mark or two says nothing about
 * a nine-month plan): every 1, 2, 3 or 6 months from the start; the label
 * is that month as yyyy-mm, for the screen to word in the person's language
 */
export function monthTicks(totalMonths: number, step: number, today: string, maxTicks = 6): ChartTick[] {
  const months = Math.max(0, totalMonths);
  const stride = MONTH_STRIDES.find((n) => Math.floor(months / n) + 1 <= maxTicks) ?? MONTH_STRIDES.at(-1) ?? 1;
  return marksEvery(months, step, stride, maxTicks, (month) => monthAfter(today, month));
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
