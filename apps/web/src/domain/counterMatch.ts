import type { TransactionRow } from '@/db/types';
import { REIMBURSED_ID } from './categories';

/** every row (and split part) some OTHER row already points at — a
 *  pointed-at row is spoken for even when its own reciprocal is missing
 *  (#237 r2: one-way pairs kept being offered as "available") */
export function pointedAtIds(rows: readonly TransactionRow[]): ReadonlySet<string> {
  const pointed = new Set<string>();
  for (const row of rows) {
    if (row.deleted !== 0) continue;
    if (row.transferPeerId) pointed.add(row.transferPeerId);
    for (const part of row.splits ?? []) {
      if (part.transferPeerId) pointed.add(part.transferPeerId);
    }
  }
  return pointed;
}

/** a row that could still become someone's other leg: not linked, not
 *  paired (in EITHER direction), never a split container (#237). A row
 *  that already points at the ANCHOR's own account without a peer IS the
 *  other leg waiting for its pair (user ss 2026-10-07: the card's
 *  repayment, filed as a transfer from the checking account, never
 *  appeared in the checking row's picker) */
const openRow = (
  row: TransactionRow,
  counterAccountId: string,
  anchor: { id: string; accountId?: string },
  pointed: ReadonlySet<string>,
): boolean =>
  row.deleted === 0 &&
  row.id !== anchor.id &&
  row.accountId === counterAccountId &&
  (!row.linkedAccountId || (anchor.accountId !== undefined && row.linkedAccountId === anchor.accountId)) &&
  !row.transferPeerId &&
  !pointed.has(row.id) &&
  (row.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length <= 1;

/** the mirror rows first: a row pointing back at the anchor's account outranks a loose one */
const mirrorFirst = (anchorAccountId: string | undefined) => (a: TransactionRow, b: TransactionRow): number => {
  if (anchorAccountId === undefined) return 0;
  return Number(b.linkedAccountId === anchorAccountId) - Number(a.linkedAccountId === anchorAccountId);
};

/** the anchor a picker matches against: its own account lets a mirror row qualify */
export interface MatchAnchor {
  id: string;
  amountCents: number;
  date: string;
  accountId?: string;
}

function nearMatches(
  rows: readonly TransactionRow[],
  counterAccountId: string,
  anchor: MatchAnchor,
  sign: 1 | -1,
  limit: number,
): TransactionRow[] {
  const anchorAbs = Math.abs(anchor.amountCents);
  const anchorTime = Date.parse(anchor.date);
  const tolerance = Math.max(100, Math.round(anchorAbs * 0.02));
  const pointed = pointedAtIds(rows);
  const mirror = mirrorFirst(anchor.accountId);
  return rows
    .filter((row) => openRow(row, counterAccountId, anchor, pointed) && Math.sign(row.amountCents) === sign)
    .map((row) => ({
      row,
      amountDiff: Math.abs(Math.abs(row.amountCents) - anchorAbs),
      dayDiff: Math.abs(Date.parse(row.date) - anchorTime) / 86_400_000,
    }))
    .filter((entry) => entry.amountDiff <= tolerance && entry.dayDiff <= 7)
    .sort((a, b) => mirror(a.row, b.row) || a.amountDiff - b.amountDiff || a.dayDiff - b.dayDiff)
    .slice(0, limit)
    .map((entry) => entry.row);
}

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
  anchor: MatchAnchor,
  limit = 5,
): TransactionRow[] {
  return nearMatches(rows, counterAccountId, anchor, (Math.sign(anchor.amountCents) * -1) as 1 | -1, limit);
}

/**
 * #237 (user decision "a"): the WALLET story — PayPal-style feeds show
 * both halves of one purchase as debits (the top-up income legs never
 * arrive), so the other leg of a bank debit can be a SAME-SIGN row on
 * the wallet account. Same nearness rules as counterDuplicates; the
 * caller offers these only when no opposite-sign twin exists.
 */
export function counterSameSignCandidates(
  rows: readonly TransactionRow[],
  counterAccountId: string,
  anchor: MatchAnchor,
  limit = 5,
): TransactionRow[] {
  return nearMatches(rows, counterAccountId, anchor, Math.sign(anchor.amountCents) as 1 | -1, limit);
}

/**
 * #237: the fork's "show all" list — every row on the counter account
 * that could still be pointed at (open: unlinked, unpaired either way,
 * not a split container), newest first. The near candidates above are
 * its head; this is the browse view behind them.
 */
export function counterOpenRows(
  rows: readonly TransactionRow[],
  counterAccountId: string,
  anchor: string | { id: string; accountId?: string },
  limit = 30,
): TransactionRow[] {
  const pointed = pointedAtIds(rows);
  const at = typeof anchor === 'string' ? { id: anchor } : anchor;
  const mirror = mirrorFirst(at.accountId);
  return rows
    .filter((row) => openRow(row, counterAccountId, at, pointed))
    .sort((a, b) => mirror(a, b) || b.date.localeCompare(a.date))
    .slice(0, limit);
}
