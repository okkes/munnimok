import type { AccountRow, RecurringRow, SpacePeriodType, TxView } from '@/db/types';
import { knownCents } from '@/lib/money';
import { LIQUID_TYPES } from './balanceBand';
import type { PaydayInfo } from './cashflow';
import { REIMBURSED_ID, mainCatOf } from './categories';
import { addDays, occurrencesBetween } from './recurring';
import { netAmountCents } from './reimbursement';
import { txSliceViews } from './txSlices';
import type { Period } from './periods';

// reimbursements count NET (consistent with every list); pending rows are the bank's reservation noise and stay out

interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
  childrenOf: (id: string) => { id: string }[];
}

/** the earlier of two ISO dates (lexicographic — these are strings, not numbers) */
export const minIso = (a: string, b: string): string => (a < b ? a : b); // NOSONAR(S7766)

/** an amount of `currency` restated in the space's own: a sum never adds two currencies */
export type InSpaceCurrency = (cents: number, currency: string | undefined) => number;
const AS_RECORDED: InSpaceCurrency = (cents) => cents;

// funding rows are standard-typed, but the shared pot is not spending: the category family excludes them
const countable = (tx: TxView): boolean =>
  tx.deleted === 0 && tx.pending !== 1 && tx.txType === 'expense' && mainCatOf(tx.catId) !== 'funding';

function coveredIds(catalog: CatalogLookup, catId: string): Set<string> {
  return new Set([catId, ...catalog.childrenOf(catId).map((child) => child.id)]);
}

// every main brings its subs, ones created later too (resolved live); a sub stands for itself;
// null or an empty pick means every expense
export function scopeIds(catalog: CatalogLookup, catIds: readonly string[] | null | undefined): Set<string> | null {
  if (!catIds || catIds.length === 0) return null;
  const ids = new Set<string>();
  for (const catId of catIds) for (const id of coveredIds(catalog, catId)) ids.add(id);
  return ids;
}

// #211: container parts, per-part spreads and the row's `cats` count toward their actual category
// the settled `reimbursed` value is not spending
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

export function scopedBreakdown(
  txs: readonly TxView[],
  period: Period,
  ids: ReadonlySet<string> | null,
  inSpace: InSpaceCurrency = AS_RECORDED,
): BreakdownRow[] {
  const sums = new Map<string, number>();
  for (const tx of txs) {
    if (!countable(tx) || tx.date < period.start || tx.date > period.end) continue;
    for (const slice of scopedSlices(tx, ids)) {
      if (slice.cents > 0) sums.set(slice.catId, (sums.get(slice.catId) ?? 0) + inSpace(slice.cents, tx.currency));
    }
  }
  return [...sums].map(([catId, cents]) => ({ catId, cents })).sort((a, b) => b.cents - a.cents);
}

export const scopedContribution = (tx: TxView, ids: ReadonlySet<string> | null): number =>
  countable(tx) ? txContribution(tx, ids) : 0;

export function expenseSeries(
  txs: readonly TxView[],
  periods: readonly Period[],
  ids: ReadonlySet<string> | null,
  inSpace: InSpaceCurrency = AS_RECORDED,
): number[] {
  return periods.map((period) => {
    let sum = 0;
    for (const tx of txs) {
      if (countable(tx) && tx.date >= period.start && tx.date <= period.end) sum += inSpace(txContribution(tx, ids), tx.currency);
    }
    return sum;
  });
}

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

export const periodDays = (period: Period): number => dayDiff(period.start, period.end) + 1;

/** the 0-based day-of-period of a date (negative or past the end when outside) */
export const dayIndexOf = (date: string, period: Period): number => dayDiff(period.start, date);

export function cumulativeByDay(
  txs: readonly TxView[],
  period: Period,
  catIds: readonly string[] | null,
  catalog: CatalogLookup,
  inSpace: InSpaceCurrency = AS_RECORDED,
): number[] {
  const ids = scopeIds(catalog, catIds);
  const perDay = new Array<number>(periodDays(period)).fill(0);
  for (const tx of txs) {
    if (!countable(tx) || tx.date < period.start || tx.date > period.end) continue;
    perDay[dayIndexOf(tx.date, period)] += inSpace(txContribution(tx, ids), tx.currency);
  }
  let running = 0;
  const out: number[] = [];
  for (const cents of perDay) {
    running += cents;
    out.push(running);
  }
  return out;
}

/** what a cumulative series had reached by a day-of-period — a shorter
 *  period is read at its last day, a day before the first reads zero */
export function reachedBy(cumulative: readonly number[], dayIndex: number): number {
  const at = Math.min(dayIndex, cumulative.length - 1);
  return at < 0 ? 0 : cumulative[at];
}

export interface CashflowPoint {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
}

/** income vs expense per period (gross income, net expenses) */
export function cashflowSeries(txs: readonly TxView[], periods: readonly Period[], inSpace: InSpaceCurrency = AS_RECORDED): CashflowPoint[] {
  return periods.map((period) => {
    let income = 0;
    let expense = 0;
    for (const tx of txs) {
      if (tx.deleted !== 0 || tx.pending === 1 || tx.date < period.start || tx.date > period.end) continue;
      if (mainCatOf(tx.catId) === 'funding') continue; // the pot is not cashflow
      if (tx.txType === 'income') income += inSpace(tx.amountCents, tx.currency);
      else if (tx.txType === 'expense') expense += inSpace(Math.abs(netAmountCents(tx)), tx.currency);
    }
    return { incomeCents: income, expenseCents: expense, netCents: income - expense };
  });
}

export interface NetWorthPoint {
  date: string;
  cents: number;
}

// balance(t) = balanceNow − Σ amounts of its transactions after t; an account without transactions is a flat line
// (honest for savings/brokerage rows that only carry a balance)
export function netWorthSeries(
  accounts: readonly (Pick<AccountRow, 'id' | 'balanceCents' | 'archived' | 'deleted'> & Partial<Pick<AccountRow, 'currency'>>)[],
  txs: readonly TxView[],
  dates: readonly string[],
  inSpace: InSpaceCurrency = AS_RECORDED,
): NetWorthPoint[] {
  const live = accounts.filter((account) => account.deleted === 0 && account.archived !== 1);
  const nowCents = live.reduce((sum, account) => sum + inSpace(knownCents(account.balanceCents), account.currency), 0);
  const accountIds = new Set(live.map((account) => account.id));
  const movements = txs
    .filter((tx) => tx.deleted === 0 && tx.pending !== 1 && accountIds.has(tx.accountId))
    .map((tx) => ({ date: tx.date, cents: inSpace(tx.amountCents, tx.currency) }));
  return dates.map((date) => {
    const after = movements.reduce((sum, m) => (m.date > date ? sum + m.cents : sum), 0);
    return { date, cents: nowCents - after };
  });
}

export interface DailyPoint {
  date: string;
  cents: number;
}

type LiquidAccount = Pick<AccountRow, 'id' | 'type' | 'balanceCents' | 'archived' | 'deleted'> & Partial<Pick<AccountRow, 'currency'>>;

// the shared pot is not among LIQUID_TYPES; pending rows stay out
// a custom graph (#531) names its own accounts, whatever their type
export function dailyBalanceSeries(
  accounts: readonly LiquidAccount[],
  txs: readonly TxView[],
  from: string,
  to: string,
  picked: readonly string[] | null = null,
  inSpace: InSpaceCurrency = AS_RECORDED,
): DailyPoint[] {
  const counts = (account: LiquidAccount) => (picked ? picked.includes(account.id) : LIQUID_TYPES.has(account.type));
  const live = accounts.filter((account) => account.deleted === 0 && account.archived !== 1 && counts(account));
  const nowCents = live.reduce((sum, account) => sum + inSpace(knownCents(account.balanceCents), account.currency), 0);
  const accountIds = new Set(live.map((account) => account.id));
  const perDay = new Map<string, number>();
  let beyond = 0; // movements after the window — already "after" every day in it
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.pending === 1 || !accountIds.has(tx.accountId)) continue;
    const cents = inSpace(tx.amountCents, tx.currency);
    if (tx.date > to) beyond += cents;
    else perDay.set(tx.date, (perDay.get(tx.date) ?? 0) + cents);
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

/** the largest credit of the day names it; income rows only, so a shuffle between own accounts never reads as salary */
export function incomeSpikes(txs: readonly TxView[], from: string, to: string, minCents = 50_000, inSpace: InSpaceCurrency = AS_RECORDED): IncomeSpike[] {
  const byDay = new Map<string, IncomeSpike>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.pending === 1 || tx.txType !== 'income' || tx.date < from || tx.date > to) continue;
    const cents = inSpace(tx.amountCents, tx.currency);
    if (cents < minCents) continue;
    const prev = byDay.get(tx.date);
    if (!prev || cents > prev.cents) {
      byDay.set(tx.date, { date: tx.date, merchant: tx.titleOverride?.trim() || tx.merchant, cents });
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

export function periodBalanceRange(daily: readonly DailyPoint[], periods: readonly Period[]): (BalanceRange | null)[] {
  return periods.map((period) => {
    let range: BalanceRange | null = null;
    for (const point of daily) {
      if (point.date >= period.start && point.date <= period.end) range = foldRange(range, point);
    }
    return range;
  });
}

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

const recurringIsIncome = (rec: Pick<RecurringRow, 'catId'>): boolean => mainCatOf(rec.catId) === 'income';

// nothing beyond the active recurring rows and the next payday is guessed; a payday is skipped when an income recurring
// already lands that day, so the salary is never counted twice
function recurringDeltas(recurrings: readonly RecurringRow[], from: string, to: string): { deltas: Map<string, number>; incomeDays: Set<string> } {
  const deltas = new Map<string, number>();
  const incomeDays = new Set<string>();
  for (const rec of recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1) continue;
    const income = recurringIsIncome(rec);
    for (const date of occurrencesBetween(rec, from, to)) {
      deltas.set(date, (deltas.get(date) ?? 0) + (income ? Math.abs(rec.amountCents) : -Math.abs(rec.amountCents)));
      if (income) incomeDays.add(date);
    }
  }
  return { deltas, incomeDays };
}

// a recurring cost carries no account of its own: it counts where its latest linked payment landed;
// one never paid belongs to no picked set (#531)
export function recurringsOnAccounts(recurrings: readonly RecurringRow[], txs: readonly TxView[], accountIds: readonly string[]): RecurringRow[] {
  const latest = new Map<string, TxView>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || !tx.recurringId) continue;
    const prev = latest.get(tx.recurringId);
    if (!prev || tx.date > prev.date) latest.set(tx.recurringId, tx);
  }
  return recurrings.filter((rec) => {
    const paid = latest.get(rec.id);
    return paid !== undefined && accountIds.includes(paid.accountId);
  });
}

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
  const { deltas, incomeDays } = recurringDeltas(recurrings, from, periodEnd);
  if (payday && payday.date >= from && payday.date <= periodEnd && !incomeDays.has(payday.date)) {
    deltas.set(payday.date, (deltas.get(payday.date) ?? 0) + payday.amountCents);
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

// a period not starting on the 1st (a periodDay, a weekly rhythm) is named by its START date ("21 Sep")
// periods on the 1st read as a month
export function trendLabels(periods: readonly Period[], periodType: SpacePeriodType, periodDay: number, locale: string): string[] {
  const n = periods.length;
  return periods.map((period, i) =>
    i === 0 || i === n - 1 || i === Math.floor(n / 2) ? periodLabel(period, periodType, periodDay, locale) : '',
  );
}

export function periodLabel(period: Period, periodType: SpacePeriodType, periodDay: number, locale: string): string {
  const byStart = periodType === 'week' || periodType === 'biweekly' || periodDay !== 1;
  return localDate(period.start).toLocaleDateString(locale, byStart ? { day: 'numeric', month: 'short' } : { month: 'short' });
}
