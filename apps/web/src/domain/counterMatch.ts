import type { TransactionRow } from '@/db/types';
import { REIMBURSED_ID } from './categories';

/**
 * #133 step B — the pick-existing "duplicate" door: rows already living
 * on the counter account that could BE the other leg of the anchor.
 * Opposite sign, close in amount (±2% with a €1 floor) and date (±7
 * days), not already paired or linked, never a split container. Sorted
 * best-first: exact amounts before near ones, then by date distance.
 */
export function counterDuplicates(
  rows: readonly TransactionRow[],
  counterAccountId: string,
  anchor: { id: string; amountCents: number; date: string },
  limit = 5,
): TransactionRow[] {
  const anchorAbs = Math.abs(anchor.amountCents);
  const anchorTime = Date.parse(anchor.date);
  const tolerance = Math.max(100, Math.round(anchorAbs * 0.02));
  return rows
    .filter(
      (row) =>
        row.deleted === 0 &&
        row.id !== anchor.id &&
        row.accountId === counterAccountId &&
        !row.linkedAccountId &&
        !row.transferPeerId &&
        Math.sign(row.amountCents) === -Math.sign(anchor.amountCents) &&
        (row.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length <= 1,
    )
    .map((row) => ({
      row,
      amountDiff: Math.abs(Math.abs(row.amountCents) - anchorAbs),
      dayDiff: Math.abs(Date.parse(row.date) - anchorTime) / 86_400_000,
    }))
    .filter((entry) => entry.amountDiff <= tolerance && entry.dayDiff <= 7)
    .sort((a, b) => a.amountDiff - b.amountDiff || a.dayDiff - b.dayDiff)
    .slice(0, limit)
    .map((entry) => entry.row);
}
