import type { AccountRow, RecurringRow, TxView } from '@/db/types';
import { merchantKey } from './merchantKey';
import { nextDueDate } from './recurring';

/**
 * Cash-flow forecast (design F1/F2): "how much can I spend before
 * payday". Pure functions; honesty rules — the block shows NOTHING
 * rather than a wrong number (no detected salary, no liquid accounts).
 */

export interface PaydayInfo {
  date: string;
  merchant: string;
  amountCents: number;
}

const isoAddMonths = (iso: string, months: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  const lastDay = new Date(y, m + months, 0).getDate();
  const date = new Date(y, m - 1 + months, Math.min(d, lastDay));
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * The next salary-like credit: the largest merchant that paid at least
 * twice in distinct months during the last four; its day-of-month
 * projects forward. Null when nothing salary-shaped exists.
 */
export function nextPayday(txs: readonly TxView[], today: string): PaydayInfo | null {
  const cutoff = isoAddMonths(today, -4);
  const groups = new Map<string, { merchant: string; months: Set<string>; latest: TxView }>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.amountCents < 10_000 || tx.pending === 1) continue; // ≥ €100
    if (tx.date < cutoff || tx.date > today) continue;
    const key = merchantKey(tx.merchant);
    const group = groups.get(key) ?? { merchant: tx.merchant, months: new Set<string>(), latest: tx };
    group.months.add(tx.date.slice(0, 7));
    if (tx.date > group.latest.date) group.latest = tx;
    groups.set(key, group);
  }
  const candidates = [...groups.values()].filter((group) => group.months.size >= 2);
  if (candidates.length === 0) return null;
  const salary = candidates.reduce((a, b) => (b.latest.amountCents > a.latest.amountCents ? b : a), candidates[0]);

  // project the latest pay date's day-of-month forward
  const payDay = Number(salary.latest.date.slice(8, 10));
  const [y, m] = today.split('-').map(Number);
  const clamp = (year: number, month: number) => Math.min(payDay, new Date(year, month, 0).getDate());
  let next = `${y}-${String(m).padStart(2, '0')}-${String(clamp(y, m)).padStart(2, '0')}`;
  if (next <= today) next = isoAddMonths(next, 1);
  return { date: next, merchant: salary.merchant, amountCents: salary.latest.amountCents };
}

export interface SafeToSpend {
  cents: number;
  perDayCents: number;
  days: number;
  payday: PaydayInfo;
  liquidCents: number;
  /** recurring costs falling due before the money arrives */
  upcoming: { rec: RecurringRow; due: string }[];
  upcomingCents: number;
  /** money the plan holds for later (#128): funded and not yet spent, plus everything funded ahead (0 for spaces without a plan) */
  plannedCents: number;
}

export function safeToSpend(input: {
  accounts: readonly Pick<AccountRow, 'id' | 'type' | 'balanceCents' | 'archived' | 'deleted'>[];
  txs: readonly TxView[];
  recurrings: readonly RecurringRow[];
  plannedCents?: number;
  today: string;
}): SafeToSpend | null {
  const payday = nextPayday(input.txs, input.today);
  if (!payday) return null;
  const liquid = input.accounts.filter(
    (account) => account.deleted === 0 && account.archived !== 1 && (account.type === 'checking' || account.type === 'cash'),
  );
  if (liquid.length === 0) return null;
  const liquidCents = liquid.reduce((sum, account) => sum + account.balanceCents, 0);

  const upcoming = input.recurrings
    .filter((rec) => rec.deleted === 0 && rec.active === 1)
    .map((rec) => ({ rec, due: nextDueDate(rec, input.today) }))
    .filter((entry): entry is { rec: RecurringRow; due: string } => entry.due !== null && entry.due <= payday.date)
    .sort((a, b) => a.due.localeCompare(b.due));
  const upcomingCents = upcoming.reduce((sum, entry) => sum + entry.rec.amountCents, 0);

  // F2: money that already has a job is not safe to spend
  const plannedCents = Math.max(0, input.plannedCents ?? 0);

  const cents = liquidCents - upcomingCents - plannedCents;
  const days = Math.max(1, Math.round((Date.parse(payday.date) - Date.parse(input.today)) / 86_400_000));
  return {
    cents,
    perDayCents: Math.floor(cents / days),
    days,
    payday,
    liquidCents,
    upcoming,
    upcomingCents,
    plannedCents,
  };
}
