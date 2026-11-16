import type { TxView } from '@/db/types';
import { merchantKey } from './merchantKey';

/** the payday the cash-flow projection (Trends) draws towards; safe to spend uses the space's own period (#541) */

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

/** the largest merchant that paid in at least two distinct months of the last four; its day-of-month projects forward */
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

  const payDay = Number(salary.latest.date.slice(8, 10));
  const [y, m] = today.split('-').map(Number);
  const clamp = (year: number, month: number) => Math.min(payDay, new Date(year, month, 0).getDate());
  let next = `${y}-${String(m).padStart(2, '0')}-${String(clamp(y, m)).padStart(2, '0')}`;
  if (next <= today) next = isoAddMonths(next, 1);
  return { date: next, merchant: salary.merchant, amountCents: salary.latest.amountCents };
}
