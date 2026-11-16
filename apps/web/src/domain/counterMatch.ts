import type { TransactionRow } from '@/db/types';
import { REIMBURSED_ID } from './categories';

/** rows and split parts some OTHER row points at are spoken for even without a reciprocal (#237) */
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

// open = not linked, not paired in either direction, never a split container (#237); a row pointing at the anchor's
// own account without a peer is the other leg waiting for its pair
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

// #133 B: opposite-sign rows on the counter account within ±2% (€1 floor) and ±7 days; exact amounts first
export function counterDuplicates(
  rows: readonly TransactionRow[],
  counterAccountId: string,
  anchor: MatchAnchor,
  limit = 5,
): TransactionRow[] {
  return nearMatches(rows, counterAccountId, anchor, (Math.sign(anchor.amountCents) * -1) as 1 | -1, limit);
}

// #237: PayPal-style feeds show both halves of a purchase as debits (the top-up income never arrives), so the other leg
// can be a same-sign wallet row; the caller offers these only when no opposite-sign twin exists
export function counterSameSignCandidates(
  rows: readonly TransactionRow[],
  counterAccountId: string,
  anchor: MatchAnchor,
  limit = 5,
): TransactionRow[] {
  return nearMatches(rows, counterAccountId, anchor, Math.sign(anchor.amountCents) as 1 | -1, limit);
}

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
