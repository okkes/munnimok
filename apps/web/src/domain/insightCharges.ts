import type { RecurringRow, TxView } from '@/db/types';
import { txTitle } from '@/lib/text';
import type { CatalogLookup, Insight, InsightInputs } from './insightModel';
import { dayDiff, inCurrency, mainOf, median, spentCents } from './insightModel';
import { merchantKey } from './merchantKey';
import { addDays, cycleKeyOf, cycleMonths, occurrencesBetween } from './recurring';
import { txSliceViews } from './txSlices';

// #516: each finding speaks in the charge's own currency and stays silent while the account's data is too old to tell

/** #356: funding-filed recurrings are money MOVED (shared pots, family accounts), not money spent */
export const isFundingRec = (rec: Pick<RecurringRow, 'catId'>, catalog: Pick<CatalogLookup, 'byId'>): boolean =>
  !!rec.catId && mainOf(rec.catId, catalog) === 'funding';

interface Charge {
  tx: TxView;
  date: string;
  /** positive: what left for the recurring cost (its linked rows or parts) */
  cents: number;
}

const chargeIndex = new WeakMap<readonly TxView[], Map<string, Charge[]>>();

function sentPerRecurring(tx: TxView): Map<string, number> {
  const byRec = new Map<string, number>();
  for (const view of txSliceViews(tx)) {
    if (view.recurringId) byRec.set(view.recurringId, (byRec.get(view.recurringId) ?? 0) - view.amountCents);
  }
  return byRec;
}

function buildChargeIndex(txs: readonly TxView[]): Map<string, Charge[]> {
  const index = new Map<string, Charge[]>();
  for (const tx of txs) {
    if (tx.deleted !== 0) continue;
    for (const [recId, cents] of sentPerRecurring(tx)) {
      if (cents <= 0) continue;
      const list = index.get(recId);
      if (list) list.push({ tx, date: tx.date, cents });
      else index.set(recId, [{ tx, date: tx.date, cents }]);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.date.localeCompare(b.date));
  return index;
}

export function chargesOf(rec: Pick<RecurringRow, 'id'>, txs: readonly TxView[]): Charge[] {
  let index = chargeIndex.get(txs);
  if (!index) {
    index = buildChargeIndex(txs);
    chargeIndex.set(txs, index);
  }
  return index.get(rec.id) ?? [];
}

const money = (cents: number, tx: Pick<TxView, 'currency'>) => ({ money: cents, ...(tx.currency ? { currency: tx.currency } : {}) });

// a fixed cost's latest billing cycle against the one before (a bill paid in two goes is one bill): at least €5 and 10% more
// subscriptions keep the sustained-change rule (priceCreep): a one-off proration says nothing about them
export function billChanged(inputs: InsightInputs): Insight[] {
  const window = inputs.periods.at(-2) ?? inputs.periods.at(-1);
  if (!window) return [];
  const out: Insight[] = [];
  for (const rec of inputs.recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1 || rec.kind !== 'fixed' || isFundingRec(rec, inputs.catalog)) continue;
    const cycles = new Map<string, { first: string; date: string; cents: number; tx: TxView }>();
    for (const charge of chargesOf(rec, inputs.txs)) {
      const key = cycleKeyOf(rec, charge.date);
      const seen = cycles.get(key);
      cycles.set(key, { first: seen?.first ?? charge.date, date: charge.date, cents: (seen?.cents ?? 0) + charge.cents, tx: charge.tx });
    }
    const list = [...cycles.values()];
    const latest = list.at(-1);
    const previous = list.at(-2);
    if (!latest || !previous || latest.date < window.start || latest.tx.currency !== previous.tx.currency) continue;
    // charges half a cycle apart are two bills in one calendar cycle (the next one paid ahead), not one bill in two goes
    if (dayDiff(latest.first, latest.date) > cycleDays(rec) / 2) continue;
    const delta = latest.cents - previous.cents;
    if (delta < Math.max(500, Math.round(previous.cents * 0.1))) continue;
    const yearly = Math.round((delta * 12) / cycleMonths(rec));
    out.push({
      id: `bill:${rec.id}:${latest.date}`,
      kind: 'creep',
      topic: 'bills',
      severity: 'leak',
      impactCents: yearly,
      icon: 'receipt-text-outline',
      titleKey: 'ins.bill.title',
      subKey: 'ins.bill.sub',
      detailKey: 'ins.bill.detail',
      lineKey: 'ins.bill.line',
      params: {
        name: rec.name,
        delta: money(delta, latest.tx),
        from: money(previous.cents, latest.tx),
        to: money(latest.cents, latest.tx),
        date: { date: latest.date },
        year: money(yearly, latest.tx),
      },
      about: rec.name,
      chart: list.slice(-8).map((cycle) => cycle.cents),
      actionTo: `/recurring/${rec.id}`,
    });
  }
  return out;
}

/** how late a charge may be before it counts as missing, and how far from its date a payment still belongs to it */
const GRACE: Record<RecurringRow['every'], number> = { week: 2, month: 5, year: 7 };
const NEAR: Record<RecurringRow['every'], number> = { week: 3, month: 10, year: 21 };

const cycleDays = (rec: Pick<RecurringRow, 'every' | 'everyN'>): number => {
  const n = Math.max(1, rec.everyN ?? 1);
  if (rec.every === 'week') return 7 * n;
  return rec.every === 'year' ? 366 * n : 31 * n;
};

/** the due date a regular recurring cost let pass without a charge, and its last charge; null while all is well or unknowable */
function missedDue(rec: RecurringRow, inputs: InsightInputs): { due: string; last: Charge } | null {
  const charges = chargesOf(rec, inputs.txs);
  const last = charges.at(-1);
  if (!last || charges.length < 2) return null;
  const span = cycleDays(rec);
  const near = NEAR[rec.every];
  const due = occurrencesBetween(rec, addDays(inputs.today, -span), addDays(inputs.today, -GRACE[rec.every])).at(-1);
  if (!due) return null;
  const paidNear = (date: string) => charges.some((c) => Math.abs(dayDiff(date, c.date)) <= near);
  const before = occurrencesBetween(rec, addDays(due, -3 * span), addDays(due, -1)).slice(-2);
  if (before.length < 2 || !before.every(paidNear)) return null;
  const since = addDays(due, -near);
  const cameUnlinked = (tx: TxView) => tx.deleted === 0 && tx.amountCents < 0 && tx.date >= since && merchantKey(tx.merchant) === rec.merchantKey;
  if (charges.some((c) => c.date >= since) || (rec.merchantKey && inputs.txs.some(cameUnlinked))) return null;
  const heardSince = addDays(due, GRACE[rec.every]);
  const heard = inputs.txs.some((tx) => tx.deleted === 0 && tx.accountId === last.tx.accountId && tx.date > heardSince);
  return heard ? { due, last } : null;
}

export function missedCharge(inputs: InsightInputs): Insight[] {
  const out: Insight[] = [];
  for (const rec of inputs.recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1 || isFundingRec(rec, inputs.catalog)) continue;
    const missed = missedDue(rec, inputs);
    if (!missed) continue;
    const { due, last } = missed;
    out.push({
      id: `missed:${rec.id}:${due}`,
      kind: 'missed',
      topic: rec.kind === 'subscription' ? 'subscriptions' : 'bills',
      severity: 'alert',
      impactCents: last.cents,
      icon: 'credit-card-clock-outline',
      titleKey: 'ins.missed.title',
      subKey: 'ins.missed.sub',
      detailKey: 'ins.missed.detail',
      lineKey: 'ins.missed.line',
      params: { name: rec.name, amount: money(last.cents, last.tx), date: { date: due } },
      about: rec.name,
      actionTo: `/recurring/${rec.id}`,
    });
  }
  return out;
}

/** a card line's own clock ("…30.10.2026 18U08 …", ING) or the row's time, as minutes on one scale; null when neither says */
export function chargeMoment(tx: Pick<TxView, 'date' | 'time' | 'merchant' | 'description'>): number | null {
  const stamp = /(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2}|\d{4})\s*(\d{1,2})[:uUhH.](\d{2})(?!\d)/;
  for (const text of [tx.description, tx.merchant]) {
    const m = text ? stamp.exec(text) : null;
    if (!m) continue;
    const [day, month, year, hour, minute] = [m[1], m[2], m[3], m[4], m[5]].map(Number);
    if (day < 1 || day > 31 || month < 1 || month > 12 || hour > 23 || minute > 59) continue;
    const iso = `${year < 100 ? 2000 + year : year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return dayDiff('2000-01-01', iso) * 1440 + hour * 60 + minute;
  }
  const clock = tx.time ? /^(\d{1,2}):(\d{2})$/.exec(tx.time) : null;
  if (!clock) return null;
  return dayDiff('2000-01-01', tx.date) * 1440 + Number(clock[1]) * 60 + Number(clock[2]);
}

/** two purchases this close together, in minutes, read as one charge booked twice */
const TWICE_WITHIN = 10;

// never three identical purchases (that is a habit); a same-amount refund settles it
// a reserved charge waits for its booked twin
/** a purchase that could be half of a double charge: booked, spent, not a pair's leg */
const isPurchase = (tx: TxView, from: string, inputs: InsightInputs): boolean =>
  tx.deleted === 0 &&
  tx.pending !== 1 &&
  tx.amountCents < 0 &&
  tx.date >= from &&
  tx.date <= inputs.today &&
  !tx.transferPeerId &&
  spentCents(tx, inputs.catalog) > 0;

function twinGap(a: TxView, b: TxView): number | null {
  const cents = -a.amountCents;
  const ma = chargeMoment(a);
  const mb = chargeMoment(b);
  if (ma !== null && mb !== null) {
    const gap = Math.abs(ma - mb);
    return gap > TWICE_WITHIN || cents < 500 ? null : Math.max(1, gap);
  }
  return a.date === b.date && cents >= 2_000 ? 0 : null;
}

function purchaseGroups(inputs: InsightInputs, from: string): Map<string, TxView[]> {
  const groups = new Map<string, TxView[]>();
  for (const tx of inputs.txs) {
    const key = isPurchase(tx, from, inputs) ? merchantKey(tx.merchant) : '';
    if (!key) continue;
    const groupKey = `${tx.accountId}|${key}|${tx.amountCents}|${tx.currency}`;
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), tx]);
  }
  return groups;
}

/** the same amount back from the merchant on the account, from the first charge until 45 days after the second */
function wasRefunded(a: TxView, b: TxView, txs: readonly TxView[]): boolean {
  const cents = -a.amountCents;
  const key = merchantKey(a.merchant);
  const until = addDays(b.date, 45);
  return txs.some(
    (tx) => tx.deleted === 0 && tx.amountCents === cents && tx.accountId === a.accountId && tx.date >= a.date && tx.date <= until && merchantKey(tx.merchant) === key,
  );
}

function duplicateInsight(a: TxView, b: TxView, gap: number): Insight {
  const cents = -a.amountCents;
  const name = txTitle(b);
  const timed = gap > 0;
  return {
    id: `dup:${a.id}:${b.id}`,
    kind: 'duplicate',
    topic: 'bills',
    severity: 'alert',
    impactCents: cents,
    icon: 'content-duplicate',
    titleKey: 'ins.dup.title',
    subKey: timed ? 'ins.dup.subMinutes' : 'ins.dup.subDay',
    detailKey: timed ? 'ins.dup.detailMinutes' : 'ins.dup.detailDay',
    lineKey: 'ins.dup.line',
    params: { name, amount: money(cents, a), date: { date: b.date }, ...(timed ? { mins: gap } : {}) },
    about: name,
    actionTo: `/transactions/${b.id}`,
  };
}

export function duplicateCharge(inputs: InsightInputs): Insight[] {
  const from = (inputs.periods.at(-2) ?? inputs.periods.at(-1))?.start;
  if (!from) return [];
  const out: Insight[] = [];
  for (const group of purchaseGroups(inputs, from).values()) {
    if (group.length !== 2) continue;
    const [a, b] = [...group].sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
    const gap = twinGap(a, b);
    if (gap === null || wasRefunded(a, b, inputs.txs)) continue;
    out.push(duplicateInsight(a, b, gap));
  }
  return out;
}

const monthShift = (yearMonth: string, by: number): string => {
  const [y, m] = yearMonth.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
};

const dayIn = (yearMonth: string, day: number): string => {
  const [y, m] = yearMonth.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${yearMonth}-${String(Math.min(day, last)).padStart(2, '0')}`;
};

interface IncomeSource {
  name: string;
  salary: boolean;
  accountId: string;
  dates: string[];
  /** per calendar month: the first day it came and the largest amount */
  months: Map<string, { day: number; cents: number }>;
}

function payOf(tx: TxView, catalog: Pick<CatalogLookup, 'byId'>): { cents: number; salary: boolean } {
  let cents = 0;
  let salary = false;
  for (const view of txSliceViews(tx)) {
    const main = mainOf(view.catId, catalog);
    // income as filed, or still uncategorized; reimbursements and the pot are not pay
    if (view.effType !== 'income' || (main !== 'income' && main !== 'general')) continue;
    cents += view.amountCents;
    if (view.catId === 'salary') salary = true;
  }
  return { cents, salary };
}

function incomeSources(inputs: InsightInputs): Map<string, IncomeSource> {
  const sources = new Map<string, IncomeSource>();
  const ordered = [...inputs.txs].sort((a, b) => a.date.localeCompare(b.date));
  for (const tx of ordered) {
    if (tx.deleted !== 0 || tx.amountCents <= 0 || tx.date > inputs.today || !inCurrency(tx, inputs.currency)) continue;
    const { cents, salary } = payOf(tx, inputs.catalog);
    const key = cents > 0 ? merchantKey(tx.merchant) : '';
    if (!key) continue;
    const source: IncomeSource = sources.get(key) ?? { name: '', salary: false, accountId: tx.accountId, dates: [], months: new Map() };
    source.name = txTitle(tx);
    source.accountId = tx.accountId;
    source.salary ||= salary;
    source.dates.push(tx.date);
    const month = tx.date.slice(0, 7);
    const seen = source.months.get(month);
    source.months.set(month, { day: seen?.day ?? Number(tx.date.slice(8, 10)), cents: Math.max(seen?.cents ?? 0, cents) });
    sources.set(key, source);
  }
  return sources;
}

/** how many days after its usual window pay may still come before it counts as late */
const PAY_GRACE = 3;
/** pay may come this many days before its window (a weekend, the holidays) */
const PAY_EARLY = 10;

function payWindow(source: IncomeSource, month: string): { start: string; end: string; typical: number } | null {
  const before = [1, 2, 3].map((i) => source.months.get(monthShift(month, -i)));
  const paid = before.filter((p): p is { day: number; cents: number } => p !== undefined);
  if (paid.length < 3) return null;
  const typical = median(paid.map((p) => p.cents));
  if (typical < 30_000 || paid.some((p) => Math.abs(p.cents - typical) > typical * 0.3)) return null;
  const days = [1, 2, 3, 4, 5, 6].map((i) => source.months.get(monthShift(month, -i))?.day).filter((d): d is number => d !== undefined);
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  return hi - lo > 6 ? null : { start: dayIn(month, lo), end: dayIn(month, hi), typical };
}

function lateWindow(source: IncomeSource, inputs: InsightInputs): { start: string; end: string; typical: number } | null {
  const thisMonth = inputs.today.slice(0, 7);
  for (const month of [thisMonth, monthShift(thisMonth, -1)]) {
    const window = payWindow(source, month);
    if (!window || inputs.today < addDays(window.end, PAY_GRACE)) continue;
    const earliest = addDays(window.start, -PAY_EARLY);
    const came = source.dates.some((date) => date >= earliest);
    const heard = inputs.txs.some((tx) => tx.deleted === 0 && tx.accountId === source.accountId && tx.date > window.end);
    return !came && heard ? window : null;
  }
  return null;
}

export function salaryLate(inputs: InsightInputs): Insight[] {
  const out: Insight[] = [];
  for (const [key, source] of incomeSources(inputs)) {
    const late = lateWindow(source, inputs);
    if (!late) continue;
    const { start, end, typical } = late;
    out.push({
      id: `salary:${key}:${start}`,
      kind: 'salary',
      topic: 'income',
      severity: 'alert',
      impactCents: typical,
      icon: 'briefcase-clock-outline',
      titleKey: source.salary ? 'ins.salary.title' : 'ins.salary.titleNamed',
      subKey: 'ins.salary.sub',
      detailKey: 'ins.salary.detail',
      lineKey: 'ins.salary.line',
      params: { name: source.name, from: { date: start }, to: { date: end }, amount: { money: typical } },
      about: source.name,
    });
  }
  return out;
}
