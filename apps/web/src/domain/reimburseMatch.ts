import type { TransactionRow, TxSplit } from '@/db/types';
import { EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID } from '@/domain/categories';
import { creditRemainingCents, netAmountCents, remainingCents } from '@/domain/reimbursement';

/**
 * Candidate scoring for the reimbursement link screen (user design
 * 2026-07-28): a small "suggested" segment surfaces the 1–2 rows most
 * likely to be the counterpart the user came looking for, from timing
 * (repayments follow the expense within days), wording (Dutch P2P
 * repayment vocabulary), bookkeeping (rows already filed under the
 * reimbursement categories) and size (a repayment is never much more
 * than what it repays).
 */

/** P2P repayment vocabulary Dutch banks stamp on transfers (user list) */
const REPAY_WORDS = /tikkie|betaalverzoek|payment request|terugbetaling|terugstorting/i;

const DAY_MS = 86_400_000;
const dayDiff = (fromIso: string, toIso: string): number => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);

const REIMB_CAT_IDS = new Set<string>([EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID]);

/** the fields the earmark math reads off a row */
type ReimbRow = Pick<TransactionRow, 'catId' | 'cats' | 'splits' | 'amountCents' | 'reimbursements'>;

/** does the row book itself as reimbursement money (category, part or
 *  #211 category-spread entry)? */
export function filedAsReimbursement(tx: Pick<TransactionRow, 'catId' | 'cats' | 'splits'>): boolean {
  if (tx.catId && REIMB_CAT_IDS.has(tx.catId)) return true;
  return [...(tx.splits ?? []), ...(tx.cats ?? [])].some((s) => REIMB_CAT_IDS.has(s.catId));
}

const reimbSliceCents = (slices: readonly { catId: string; amountCents: number }[] | undefined): number | null => {
  const hits = (slices ?? []).filter((s) => REIMB_CAT_IDS.has(s.catId));
  return hits.length > 0 ? hits.reduce((sum, s) => sum + Math.abs(s.amountCents), 0) : null;
};

/** what ONE part of a split still earmarks: its own cats' slice once a
 *  settle has written them, else the whole part when it is filed so */
export function partEarmarkCents(part: Pick<TxSplit, 'catId' | 'cats' | 'amountCents'>): number | null {
  const inner = reimbSliceCents(part.cats);
  if (inner !== null) return inner;
  return REIMB_CAT_IDS.has(part.catId) ? Math.abs(part.amountCents) : null;
}

/**
 * What the row's reimbursement CATEGORY still earmarks, in cents - NET of
 * what has been settled already: a settle moves linked cents out of the
 * expected/received slice into `reimbursed`, so the slice that is left IS
 * what is still expected. Parts answer through their own cats (#228: the
 * settle lives on the part), a #211 row spread through the row's cats,
 * a row filed whole through its net value; null when the row carries no
 * reimbursement bookkeeping at all (the caller falls back to the open
 * value). 2026-10-06 (user ss): the callers used to subtract the links
 * from this once more - a second link from the same pair defaulted to
 * (earmark - links) - links and could not reach the remainder.
 */
export function reimbEarmarkCents(tx: ReimbRow): number | null {
  const parts = tx.splits ?? [];
  if (parts.length > 0) {
    const marked = parts.map(partEarmarkCents).filter((cents): cents is number => cents !== null);
    return marked.length > 0 ? marked.reduce((sum, cents) => sum + cents, 0) : null;
  }
  const spread = reimbSliceCents(tx.cats);
  if (spread !== null) return spread;
  if (tx.catId && REIMB_CAT_IDS.has(tx.catId)) return Math.abs(netAmountCents(tx));
  return null;
}

/** #197: what a split expense's PART still expects back - its magnitude
 *  minus the links already targeting it */
export function partOpenCents(row: Pick<TransactionRow, 'reimbursements'>, part: Pick<TxSplit, 'id' | 'amountCents'>): number {
  return Math.max(
    0,
    Math.abs(part.amountCents) - (row.reimbursements ?? []).filter((r) => r.partId === part.id).reduce((sum, r) => sum + r.amountCents, 0),
  );
}

/**
 * What an expense (or one of its parts) still NEEDS back: its open value,
 * capped by its reimbursement earmark when it carries one - the default
 * amount of a link. The earmark is already net of the settle (above), so
 * nothing is subtracted twice.
 */
export function expenseNeedCents(expense: ReimbRow, partId?: string): number {
  const part = partId ? (expense.splits ?? []).find((p) => p.id === partId) : undefined;
  if (part) {
    const open = partOpenCents(expense, part);
    const earmark = partEarmarkCents(part);
    return earmark === null ? open : Math.min(open, earmark);
  }
  const open = remainingCents(expense);
  const earmark = reimbEarmarkCents(expense);
  return earmark === null ? open : Math.min(open, earmark);
}

/**
 * What a credit can still give - its open value, capped by its received-
 * reimbursement earmark when it carries one (a split's received slice funds
 * links; its groceries slice never does - user rule 2026-07-28). The earmark
 * is net of the settle, so `given` is not subtracted from it again.
 */
export function creditGiveableCents(credit: ReimbRow, given: number): number {
  const net = creditRemainingCents(credit, given);
  const earmark = reimbEarmarkCents(credit);
  return earmark === null ? net : Math.max(0, Math.min(net, earmark));
}

function amountScore(candidateCents: number, neededCents: number): number {
  if (candidateCents <= 0 || neededCents <= 0) return 0;
  if (candidateCents === neededCents) return 3;
  if (candidateCents <= neededCents) return 2;
  if (candidateCents <= neededCents * 1.25) return 1;
  return 0; // a repayment far bigger than the expense is a different story
}

function timingScore(days: number): number {
  if (days >= 0 && days <= 7) return 2; // same day … a week later (user rule)
  if (days >= -2 && days <= 14) return 1;
  return 0;
}

export interface ScoredCandidate<T extends TransactionRow> {
  tx: T;
  score: number;
}

/**
 * Rank counterpart candidates for `anchor`. Direction follows the
 * anchor's sign: an expense looks forward in time at credits, a credit
 * looks back at expenses. Only rows scoring at least 4 qualify — one
 * weak signal alone never makes a suggestion.
 */
export function suggestCounterparts<T extends TransactionRow>(
  anchor: TransactionRow,
  candidates: readonly T[],
  givenOf: (id: string) => number,
): ScoredCandidate<T>[] {
  const anchorIsExpense = anchor.amountCents < 0;
  const needed = anchorIsExpense ? remainingCents(anchor) : creditRemainingCents(anchor, givenOf(anchor.id));
  const scored = candidates.map((tx) => {
    const filed = filedAsReimbursement(tx) ? 3 : 0;
    const worded = REPAY_WORDS.test(tx.merchant) ? 2 : 0;
    const days = anchorIsExpense ? dayDiff(anchor.date, tx.date) : dayDiff(tx.date, anchor.date);
    const size = anchorIsExpense
      ? amountScore(creditRemainingCents(tx, givenOf(tx.id)), needed)
      : amountScore(needed, remainingCents(tx));
    return { tx, score: filed + worded + timingScore(days) + size };
  });
  return scored
    .filter((entry) => entry.score >= 4)
    .sort((a, b) => b.score - a.score || b.tx.date.localeCompare(a.tx.date))
    .slice(0, 2);
}
