import type { AccountRow, BudgetRow, RecurringRow, SpacePeriodType, TxView, WeekStart } from '@/db/types';
import type { TranslationKey } from '@/i18n';
import { REIMBURSED_ID, UNCATEGORIZED_ID, mainCatOf } from './categories';
import type { Period } from './periods';
import { txSliceViews } from './txSlices';

/**
 * The insight vocabulary every detector speaks (#516): one finding, the
 * inputs the detectors read, and the spending arithmetic they share — so
 * "what counts as spending" is decided once.
 */

/** alert = check it now (a late salary, a missing or doubled charge); leak = money that drains; pattern = how you spend; win = what a change buys */
export type InsightSeverity = 'alert' | 'leak' | 'pattern' | 'win';

export type InsightTopic = 'subscriptions' | 'bills' | 'spending' | 'income' | 'debt' | 'behaviour' | 'budgets';

/** the detector behind a finding — findings of one kind give the same advice and share one card */
export type InsightKind =
  | 'missed'
  | 'salary'
  | 'duplicate'
  | 'creep'
  | 'overlap'
  | 'habit'
  | 'drift'
  | 'pace'
  | 'weekday'
  | 'budget'
  | 'nospend'
  | 'debtacc'
  | 'debtclear';

/** a value in a finding's copy, typed so every screen words it the same way */
export type InsightParam =
  | string
  | number
  | { money: number; currency?: string }
  | { date: string }
  | { weekday: number }
  | { cat: string }
  | { unit: SpacePeriodType }
  | { units: SpacePeriodType };

export interface Insight {
  /** encodes the subject: a dismissed finding returns only when the situation changes */
  id: string;
  kind: InsightKind;
  topic: InsightTopic;
  severity: InsightSeverity;
  /** the ranking key — the yearly money at stake, or the amount an alert is about */
  impactCents: number;
  icon: string;
  titleKey: TranslationKey;
  /** the short line under the title; absent = the yearly impact (a win: what it saves) */
  subKey?: TranslationKey;
  detailKey: TranslationKey;
  /** the finding as one line of a card that holds several; absent = its title */
  lineKey?: TranslationKey;
  params: Record<string, InsightParam>;
  /** what the finding is about, for a card that lists several (a name or a category) */
  about?: InsightParam;
  /** small history the card can chart */
  chart?: number[];
  /** the bar the chart stresses; absent = the last */
  chartFocus?: number;
  /** where the fix lives */
  actionTo?: string;
}

export interface CatalogLookup {
  byId: (id: string | undefined) => { id: string; parentId?: string };
  childrenOf: (id: string) => { id: string }[];
}

export interface InsightInputs {
  txs: readonly TxView[];
  recurrings: readonly RecurringRow[];
  budgets: readonly BudgetRow[];
  /** loans v2: the tracked liability accounts (the account IS the debt) */
  loans: readonly AccountRow[];
  accountsById: ReadonlyMap<string, AccountRow>;
  catalog: CatalogLookup;
  /** oldest → current: the space's last complete periods and the running one */
  periods: readonly Period[];
  /** the local day (yyyy-mm-dd) */
  today: string;
  /** the space's ledger currency — sums never mix in another one */
  currency: string;
  /** the space's first weekday + period shape — budget cycles depend on them (#369, #370) */
  space?: { weekStart?: WeekStart; periodType: SpacePeriodType; periodDay: number } | null;
}

// ── dates ──────────────────────────────────────────────────────────────

const utcDay = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** whole days from a to b (calendar days — DST never shifts them) */
export const dayDiff = (a: string, b: string): number => utcDay(b) - utcDay(a);

/** 0 = Sunday … 6 = Saturday */
export const weekdayOf = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

export const periodLength = (period: Period): number => dayDiff(period.start, period.end) + 1;

export const PERIODS_PER_YEAR: Record<SpacePeriodType, number> = { month: 12, week: 52, biweekly: 26, custom: 12 };

/** the oldest day the space shows a transaction for — before it nothing is known */
export function firstKnownDay(txs: readonly TxView[]): string | null {
  let first: string | null = null;
  for (const tx of txs) {
    if (tx.deleted === 0 && (first === null || tx.date < first)) first = tx.date;
  }
  return first;
}

/** the complete periods (every one but the running) whose whole span the data covers */
export function coveredPastPeriods(inputs: Pick<InsightInputs, 'periods' | 'txs'>): Period[] {
  const first = firstKnownDay(inputs.txs);
  if (first === null) return [];
  return inputs.periods.slice(0, -1).filter((p) => p.start >= first);
}

// ── spending ───────────────────────────────────────────────────────────

/** the funding pot and the reimbursement family are money that comes back or moves on — never spending */
const NOT_SPENDING = new Set(['funding', 'reimbursement']);

/** the main a category belongs to: the built-in catalog answers first, custom categories through the space's */
export const mainOf = (catId: string | undefined, catalog: Pick<CatalogLookup, 'byId'>): string => {
  const builtin = mainCatOf(catId ?? UNCATEGORIZED_ID);
  if (builtin) return builtin;
  const cat = catalog.byId(catId);
  return cat.parentId ?? cat.id;
};

/** a row in another currency is never summed into the space's own */
export const inCurrency = (tx: Pick<TxView, 'currency'>, currency: string): boolean => !tx.currency || tx.currency === currency;

export interface SpendFilter {
  /** leave out what a recurring cost pays — fixed obligations, not day-to-day choices */
  skipRecurring?: boolean;
  /** leave out what belongs to an event — a one-off occasion, not a habit */
  skipEvents?: boolean;
}

/**
 * The spending inside one transaction, per category it touches (refunds
 * negative): its expense parts, minus the funding pot and the
 * reimbursement family, the settled value never — the overview's Spent
 * without the money that comes back.
 */
export function spendParts(tx: TxView, catalog: Pick<CatalogLookup, 'byId'>, filter: SpendFilter = {}): { catId: string | undefined; cents: number }[] {
  const out: { catId: string | undefined; cents: number }[] = [];
  for (const view of txSliceViews(tx)) {
    if (view.catId === REIMBURSED_ID || view.effType !== 'expense') continue;
    if (NOT_SPENDING.has(mainOf(view.catId, catalog))) continue;
    if (filter.skipRecurring && view.recurringId) continue;
    if (filter.skipEvents && view.eventId) continue;
    out.push({ catId: view.catId, cents: -view.amountCents });
  }
  return out;
}

export const spentCents = (tx: TxView, catalog: Pick<CatalogLookup, 'byId'>, filter: SpendFilter = {}): number =>
  spendParts(tx, catalog, filter).reduce((sum, part) => sum + part.cents, 0);

/** the day-to-day spending: no recurring obligations, no events */
export const EVERYDAY: SpendFilter = { skipRecurring: true, skipEvents: true };

/** per day, what was spent in the space's currency (net of refunds) */
export function dailySpend(inputs: Pick<InsightInputs, 'txs' | 'catalog' | 'currency'>, filter: SpendFilter, from: string, to: string): Map<string, number> {
  const days = new Map<string, number>();
  for (const tx of inputs.txs) {
    if (tx.deleted !== 0 || tx.date < from || tx.date > to || !inCurrency(tx, inputs.currency)) continue;
    const cents = spentCents(tx, inputs.catalog, filter);
    if (cents !== 0) days.set(tx.date, (days.get(tx.date) ?? 0) + cents);
  }
  return days;
}

export const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};
