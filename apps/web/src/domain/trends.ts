import type { AccountRow, RecurringRow, SpacePeriodType, TxView } from '@/db/types';
import { LIQUID_TYPES } from './balanceBand';
import type { PaydayInfo } from './cashflow';
import { REIMBURSED_ID, mainCatOf } from './categories';
import { addDays, occurrencesBetween } from './recurring';
import { netAmountCents } from './reimbursement';
import { txSliceViews } from './txSlices';
import type { Period } from './periods';

/**
 * Trends & net worth (design T1/T2): pure series builders over local
 * data. Reimbursements count NET (consistent with every list); pending
 * rows are the bank's reservation noise and stay out.
 */

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
  childrenOf: (id: string) => { id: string }[];
}

/** the earlier of two ISO dates (lexicographic — these are strings, not numbers) */
export const minIso = (a: string, b: string): string => (a < b ? a : b); // NOSONAR(S7766)

// funding rows are standard-typed since the type retired (2026-08-05)
// but the shared pot is not spending — the category family excludes them
const countable = (tx: TxView): boolean =>
  tx.deleted === 0 && tx.pending !== 1 && tx.txType === 'expense' && mainCatOf(tx.catId) !== 'funding';

/** the cat ids a selection covers: a main includes its subs, a sub itself */
function coveredIds(catalog: CatalogLookup, catId: string): Set<string> {
  return new Set([catId, ...catalog.childrenOf(catId).map((child) => child.id)]);
}

/**
 * The ids a graph's scope covers (user 2026-10-08: a custom graph picks
 * one or more mains and/or subs): every main brings its subs — the ones
 * created later too, since this resolves live — and a sub stands for
 * itself. Null (or an empty pick) means every expense.
 */
export function scopeIds(catalog: CatalogLookup, catIds: readonly string[] | null | undefined): Set<string> | null {
  if (!catIds || catIds.length === 0) return null;
  const ids = new Set<string>();
  for (const catId of catIds) for (const id of coveredIds(catalog, catId)) ids.add(id);
  return ids;
}

/** the slices of one transaction that fall inside the covered categories
 *  — the canonical slice fan-out (#211): container parts, per-part
 *  spreads and the row's own `cats` partition all count toward their
 *  actual category; the settled `reimbursed` value is not spending */
function* scopedSlices(tx: TxView, ids: ReadonlySet<string> | null): Generator<{ catId: string; cents: number }> {
  // a partitionless row settles via its links alone — net keeps it honest
  if (!tx.cats?.length && !tx.splits?.length) {
    const catId = tx.catId ?? '';
    if (!ids || ids.has(catId)) yield { catId, cents: Math.abs(netAmountCents(tx)) };
    return;
  }
  for (const view of txSliceViews(tx)) {
    if (view.catId === REIMBURSED_ID) continue;
    const catId = view.catId ?? '';
    if (!ids || ids.has(catId)) yield { catId, cents: Math.abs(view.amountCents) };
  }
}

/** how much of one transaction falls inside the covered categories */
function txContribution(tx: TxView, ids: ReadonlySet<string> | null): number {
  let sum = 0;
  for (const slice of scopedSlices(tx, ids)) sum += slice.cents;
  return sum;
}

export interface BreakdownRow {
  /** '' for an uncategorized slice */
  catId: string;
  cents: number;
}

/** a period's spending inside a scope by the category each slice is
 *  actually filed under (the sub, or a main a row sits on directly),
 *  largest first — the Breakdown view (user 2026-10-08) */
export function scopedBreakdown(txs: readonly TxView[], period: Period, ids: ReadonlySet<string> | null): BreakdownRow[] {
  const sums = new Map<string, number>();
  for (const tx of txs) {
    if (!countable(tx) || tx.date < period.start || tx.date > period.end) continue;
    for (const slice of scopedSlices(tx, ids)) {
      if (slice.cents > 0) sums.set(slice.catId, (sums.get(slice.catId) ?? 0) + slice.cents);
    }
  }
  return [...sums].map(([catId, cents]) => ({ catId, cents })).sort((a, b) => b.cents - a.cents);
}

/** what a row contributes to a scope — the transactions sheet lists the rows that do */
export const scopedContribution = (tx: TxView, ids: ReadonlySet<string> | null): number =>
  countable(tx) ? txContribution(tx, ids) : 0;

/** expense cents per period inside a scope (null = every expense) */
export function expenseSeries(txs: readonly TxView[], periods: readonly Period[], ids: ReadonlySet<string> | null): number[] {
  return periods.map((period) => {
    let sum = 0;
    for (const tx of txs) {
      if (countable(tx) && tx.date >= period.start && tx.date <= period.end) sum += txContribution(tx, ids);
    }
    return sum;
  });
}

/**
 * Expense cents per period for one category (main or sub) — or ALL
 * expenses when catId is undefined. Split parts count toward their own
 * category, the remainder toward the parent's.
 */
export function categorySeries(
  txs: readonly TxView[],
  periods: readonly Period[],
  catalog: CatalogLookup,
  catId?: string,
): number[] {
  return expenseSeries(txs, periods, catId ? coveredIds(catalog, catId) : null);
}

/** the mean of the FINISHED periods that saw spending — the dashed reference line */
export function finishedAverage(values: readonly number[]): number {
  const done = values.slice(0, -1).filter((value) => value > 0);
  return done.length ? Math.round(done.reduce((a, b) => a + b, 0) / done.length) : 0;
}

/** ISO dates parse as UTC midnights — day diffs come out exact */
const dayDiff = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** how many days a period spans (inclusive bounds) */
export const periodDays = (period: Period): number => dayDiff(period.start, period.end) + 1;

/** the 0-based day-of-period of a date (negative or past the end when outside) */
export const dayIndexOf = (date: string, period: Period): number => dayDiff(period.start, date);

/**
 * Cumulative expense cents per day of a period (index 0 = the period's
 * first day, one entry per day up to its end) inside a scope — the
 * "how am I doing against last period" line (user 2026-10-08). The same
 * countable/contribution rules as the period series.
 */
export function cumulativeByDay(
  txs: readonly TxView[],
  period: Period,
  catIds: readonly string[] | null,
  catalog: CatalogLookup,
): number[] {
  const ids = scopeIds(catalog, catIds);
  const perDay = new Array<number>(periodDays(period)).fill(0);
  for (const tx of txs) {
    if (!countable(tx) || tx.date < period.start || tx.date > period.end) continue;
    perDay[dayIndexOf(tx.date, period)] += txContribution(tx, ids);
  }
  let running = 0;
  const out: number[] = [];
  for (const cents of perDay) {
    running += cents;
    out.push(running);
  }
  return out;
}

export interface SameDayPoint {
  period: Period;
  cents: number;
}

/** the cumulative spend each period had reached at the same day-of-period
 *  (a shorter period is read at its last day) */
export function sameDayComparison(
  txs: readonly TxView[],
  periods: readonly Period[],
  dayIndex: number,
  catIds: readonly string[] | null,
  catalog: CatalogLookup,
): SameDayPoint[] {
  return periods.map((period) => {
    const cumulative = cumulativeByDay(txs, period, catIds, catalog);
    const at = Math.min(dayIndex, cumulative.length - 1);
    return { period, cents: at < 0 ? 0 : cumulative[at] };
  });
}

export interface CashflowPoint {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
}

/** income vs expense per period (gross income, net expenses) */
export function cashflowSeries(txs: readonly TxView[], periods: readonly Period[]): CashflowPoint[] {
  return periods.map((period) => {
    let income = 0;
    let expense = 0;
    for (const tx of txs) {
      if (tx.deleted !== 0 || tx.pending === 1 || tx.date < period.start || tx.date > period.end) continue;
      if (mainCatOf(tx.catId) === 'funding') continue; // the pot is not cashflow
      if (tx.txType === 'income') income += tx.amountCents;
      else if (tx.txType === 'expense') expense += Math.abs(netAmountCents(tx));
    }
    return { incomeCents: income, expenseCents: expense, netCents: income - expense };
  });
}

export interface NetWorthPoint {
  date: string;
  cents: number;
}

/**
 * Balance history reconstructed, not stored: for every account,
 * balance(t) = balanceNow − Σ amounts of its transactions AFTER t.
 * Accounts without transactions contribute a flat line — honest for
 * savings/brokerage rows that only carry a balance.
 */
export function netWorthSeries(
  accounts: readonly Pick<AccountRow, 'id' | 'balanceCents' | 'archived' | 'deleted'>[],
  txs: readonly TxView[],
  dates: readonly string[],
): NetWorthPoint[] {
  const live = accounts.filter((account) => account.deleted === 0 && account.archived !== 1);
  const nowCents = live.reduce((sum, account) => sum + account.balanceCents, 0);
  const accountIds = new Set(live.map((account) => account.id));
  const movements = txs
    .filter((tx) => tx.deleted === 0 && tx.pending !== 1 && accountIds.has(tx.accountId))
    .map((tx) => ({ date: tx.date, cents: tx.amountCents }));
  return dates.map((date) => {
    const after = movements.reduce((sum, m) => (m.date > date ? sum + m.cents : sum), 0);
    return { date, cents: nowCents - after };
  });
}

export interface DailyPoint {
  date: string;
  cents: number;
}

type LiquidAccount = Pick<AccountRow, 'id' | 'type' | 'balanceCents' | 'archived' | 'deleted'>;

/**
 * The money in hand per calendar day (user 2026-10-08: the filled
 * balance line): the liquid accounts — checking, savings, cash; the
 * shared pot is not among LIQUID_TYPES — summed and walked back the net
 * worth way (balanceNow − Σ amounts after the day), one point per day
 * from `from` to `to` inclusive. Pending rows stay out.
 */
export function dailyBalanceSeries(accounts: readonly LiquidAccount[], txs: readonly TxView[], from: string, to: string): DailyPoint[] {
  const live = accounts.filter((account) => account.deleted === 0 && account.archived !== 1 && LIQUID_TYPES.has(account.type));
  const nowCents = live.reduce((sum, account) => sum + account.balanceCents, 0);
  const accountIds = new Set(live.map((account) => account.id));
  const perDay = new Map<string, number>();
  let beyond = 0; // movements after the window — already "after" every day in it
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.pending === 1 || !accountIds.has(tx.accountId)) continue;
    if (tx.date > to) beyond += tx.amountCents;
    else perDay.set(tx.date, (perDay.get(tx.date) ?? 0) + tx.amountCents);
  }
  const out: DailyPoint[] = [];
  let after = beyond;
  // walk backwards: a day's own movements are "after" the day before it
  for (let date = to; date >= from; date = addDays(date, -1)) {
    out.push({ date, cents: nowCents - after });
    after += perDay.get(date) ?? 0;
  }
  return out.reverse();
}

export interface IncomeSpike {
  date: string;
  /** the display title (the user's rename wins over the bank's name) */
  merchant: string;
  cents: number;
}

/** the days a sizeable credit landed (≥ €500 by default) and who paid it
 *  — the largest credit of the day names it; income rows only, so a
 *  shuffle between two of your own accounts never reads as salary */
export function incomeSpikes(txs: readonly TxView[], from: string, to: string, minCents = 50_000): IncomeSpike[] {
  const byDay = new Map<string, IncomeSpike>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.pending === 1 || tx.txType !== 'income' || tx.amountCents < minCents) continue;
    if (tx.date < from || tx.date > to) continue;
    const prev = byDay.get(tx.date);
    if (!prev || tx.amountCents > prev.cents) {
      byDay.set(tx.date, { date: tx.date, merchant: tx.titleOverride?.trim() || tx.merchant, cents: tx.amountCents });
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export interface BalanceRange {
  low: number;
  high: number;
  lowDate: string;
  highDate: string;
}

const foldRange = (range: BalanceRange | null, point: DailyPoint): BalanceRange => {
  if (!range) return { low: point.cents, high: point.cents, lowDate: point.date, highDate: point.date };
  if (point.cents < range.low) return { ...range, low: point.cents, lowDate: point.date };
  if (point.cents > range.high) return { ...range, high: point.cents, highDate: point.date };
  return range;
};

/** each period's lowest and highest daily balance (null where the daily
 *  series has no day inside the period) */
export function periodBalanceRange(daily: readonly DailyPoint[], periods: readonly Period[]): (BalanceRange | null)[] {
  return periods.map((period) => {
    let range: BalanceRange | null = null;
    for (const point of daily) {
      if (point.date >= period.start && point.date <= period.end) range = foldRange(range, point);
    }
    return range;
  });
}

/** the middle value of a sorted copy (the mean of the two middles for an even count) */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export interface ProjectionPoint {
  date: string;
  cents: number;
}

/** a recurring row filed under the Income family pays IN */
const recurringIsIncome = (rec: Pick<RecurringRow, 'catId'>): boolean => mainCatOf(rec.catId) === 'income';

/**
 * The expected path from today to the period's end (user 2026-10-08: the
 * dashed tail of the balance line): starts at today's balance, then one
 * point per day something is due — the active recurring rows' occurrences
 * (negative for costs, positive for rows filed as income) and the next
 * payday when it falls inside the period (skipped when an income recurring
 * already lands that day, so the salary is never counted twice) — and ends
 * flat at the period end. Nothing beyond those rows is guessed.
 */
export function balanceProjection(
  todayCents: number,
  today: string,
  periodEnd: string,
  recurrings: readonly RecurringRow[],
  payday: PaydayInfo | null,
): ProjectionPoint[] {
  const out: ProjectionPoint[] = [{ date: today, cents: todayCents }];
  if (periodEnd <= today) return out;
  const from = addDays(today, 1);
  const deltas = new Map<string, number>();
  const incomeDays = new Set<string>();
  const add = (date: string, cents: number) => deltas.set(date, (deltas.get(date) ?? 0) + cents);
  for (const rec of recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1) continue;
    const income = recurringIsIncome(rec);
    for (const date of occurrencesBetween(rec, from, periodEnd)) {
      add(date, income ? Math.abs(rec.amountCents) : -Math.abs(rec.amountCents));
      if (income) incomeDays.add(date);
    }
  }
  if (payday && payday.date >= from && payday.date <= periodEnd && !incomeDays.has(payday.date)) {
    add(payday.date, payday.amountCents);
  }
  let running = todayCents;
  for (const date of [...deltas.keys()].sort((a, b) => a.localeCompare(b))) {
    running += deltas.get(date) ?? 0;
    out.push({ date, cents: running });
  }
  if (out.at(-1)?.date !== periodEnd) out.push({ date: periodEnd, cents: running });
  return out;
}

/** a yyyy-mm-dd as a LOCAL date — `new Date(iso)` is UTC midnight, a day short west of Greenwich */
export function localDate(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Sparse x labels for a period axis — first, middle, last, so the chart
 * stays calm. User 2026-10-08: the whole trend respects the period dates,
 * so a period that does not start on the 1st (a periodDay, a weekly
 * rhythm) is named by its START date ("21 Sep"); only periods on the 1st
 * read as a month ("Sep").
 */
export function trendLabels(periods: readonly Period[], periodType: SpacePeriodType, periodDay: number, locale: string): string[] {
  const n = periods.length;
  return periods.map((period, i) =>
    i === 0 || i === n - 1 || i === Math.floor(n / 2) ? periodLabel(period, periodType, periodDay, locale) : '',
  );
}

/** one period's name on an axis: its start date, or the month for periods on the 1st */
export function periodLabel(period: Period, periodType: SpacePeriodType, periodDay: number, locale: string): string {
  const byStart = periodType === 'week' || periodType === 'biweekly' || periodDay !== 1;
  return localDate(period.start).toLocaleDateString(locale, byStart ? { day: 'numeric', month: 'short' } : { month: 'short' });
}
