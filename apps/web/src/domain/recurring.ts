import type { RecurringRow } from '@/db/types';

/**
 * Recurring-cost math. All date arithmetic is calendar-based (year /
 * month / day), never millisecond diffs — DST already burned us once.
 */

const pad = (n: number) => String(n).padStart(2, '0');
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const parts = (isoDate: string): [number, number, number] => {
  const [y, m, d] = isoDate.split('-').map(Number);
  return [y, m, d];
};
const daysInMonth = (y: number, m: number) => new Date(y, m, 0).getDate();

export const addDays = (isoDate: string, n: number): string => {
  const [y, m, d] = parts(isoDate);
  const dt = new Date(y, m - 1, d + n, 12); // noon: immune to DST day-shifts
  return toIso(dt.getFullYear(), dt.getMonth() + 1, dt.getDate());
};

/** the recurring's occurrence in a given calendar month, or null */
function occurrenceIn(rec: Pick<RecurringRow, 'every' | 'dueDay' | 'dueMonth'>, y: number, m: number): string | null {
  if (rec.every === 'year' && m !== (rec.dueMonth ?? 1)) return null;
  return toIso(y, m, Math.min(rec.dueDay, daysInMonth(y, m)));
}

const withinLifetime = (rec: Pick<RecurringRow, 'since' | 'until'>, date: string): boolean =>
  (!rec.since || date >= rec.since) && (!rec.until || date <= rec.until);

/** every occurrence date within [from, to], honoring since/until */
export function occurrencesBetween(
  rec: Pick<RecurringRow, 'every' | 'dueDay' | 'dueMonth' | 'since' | 'until'>,
  from: string,
  to: string,
): string[] {
  const [fy, fm] = parts(from);
  const [ty, tm] = parts(to);
  const out: string[] = [];
  for (let y = fy, m = fm; y < ty || (y === ty && m <= tm); m === 12 ? (y++, (m = 1)) : m++) {
    const date = occurrenceIn(rec, y, m);
    if (date && date >= from && date <= to && withinLifetime(rec, date)) out.push(date);
  }
  return out;
}

/** the next occurrence on/after today, or null (inactive / ended) */
export function nextDueDate(
  rec: Pick<RecurringRow, 'active' | 'every' | 'dueDay' | 'dueMonth' | 'since' | 'until'>,
  today: string,
): string | null {
  if (rec.active !== 1) return null;
  const [y, m] = parts(today);
  for (let i = 0; i < 24; i++) {
    const mm = ((m - 1 + i) % 12) + 1;
    const yy = y + Math.floor((m - 1 + i) / 12);
    const date = occurrenceIn(rec, yy, mm);
    if (date && date >= today && withinLifetime(rec, date)) return date;
    if (rec.until && toIso(yy, mm, 1) > rec.until) return null;
  }
  return null;
}

/** an actual payment within 25% (or €1 for small amounts) of the estimate */
export const recurringAmountMatches = (rec: Pick<RecurringRow, 'amountCents'>, txAmountCents: number): boolean =>
  Math.abs(Math.abs(txAmountCents) - rec.amountCents) <= Math.max(100, rec.amountCents * 0.25);

export const isDueWithin = (
  rec: Pick<RecurringRow, 'active' | 'every' | 'dueDay' | 'dueMonth' | 'since' | 'until'>,
  today: string,
  days: number,
): boolean => {
  const next = nextDueDate(rec, today);
  return next !== null && next <= addDays(today, days);
};

/**
 * The estimate rectified by facts: once transactions are linked, the
 * average of the latest three actual amounts replaces the user's guess.
 */
export function effectiveAmountCents(rec: Pick<RecurringRow, 'amountCents'>, linkedAmounts: readonly number[]): number {
  if (linkedAmounts.length === 0) return Math.abs(rec.amountCents);
  const latest = linkedAmounts.slice(-3).map((a) => Math.abs(a));
  return Math.round(latest.reduce((s, a) => s + a, 0) / latest.length);
}

export interface LinkedTx {
  date: string;
  amountCents: number;
}

export interface RecurringComputed {
  rec: RecurringRow;
  /** occurrences in range × effective amount */
  expectedCents: number;
  /** abs sum of linked transactions inside the range */
  paidCents: number;
  occurrences: number;
  paid: boolean;
  nextDue: string | null;
  effectiveCents: number;
}

/** per-recurring numbers for a date range (a budget period or a year) */
export function computeRange(
  recs: readonly RecurringRow[],
  linkedByRec: ReadonlyMap<string, readonly LinkedTx[]>,
  from: string,
  to: string,
  today: string,
): RecurringComputed[] {
  return recs.map((rec) => {
    const linked = [...(linkedByRec.get(rec.id) ?? [])].sort((a, b) => a.date.localeCompare(b.date));
    const effectiveCents = effectiveAmountCents(rec, linked.map((t) => t.amountCents));
    const occurrences = rec.active === 1 ? occurrencesBetween(rec, from, to).length : 0;
    const inRange = linked.filter((t) => t.date >= from && t.date <= to);
    const paidCents = inRange.reduce((s, t) => s + Math.abs(t.amountCents), 0);
    return {
      rec,
      expectedCents: occurrences * effectiveCents,
      paidCents,
      occurrences,
      paid: inRange.length > 0,
      nextDue: nextDueDate(rec, today),
      effectiveCents,
    };
  });
}

export interface RecurringSummary {
  totalCents: number;
  paidCents: number;
  remainingCents: number;
  luxuryCents: number;
}

export function summarize(computed: readonly RecurringComputed[]): RecurringSummary {
  let totalCents = 0;
  let paidCents = 0;
  let remainingCents = 0;
  let luxuryCents = 0;
  for (const c of computed) {
    totalCents += c.expectedCents;
    paidCents += c.paidCents;
    remainingCents += Math.max(0, c.expectedCents - c.paidCents);
    if (c.rec.luxury === 1) luxuryCents += c.expectedCents;
  }
  return { totalCents, paidCents, remainingCents, luxuryCents };
}
