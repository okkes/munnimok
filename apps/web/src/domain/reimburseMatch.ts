import type { TransactionRow, TxSplit } from '@/db/types';
import { EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID } from '@/domain/categories';
import { creditRemainingCents, netAmountCents, remainingCents } from '@/domain/reimbursement';

// link-screen candidate scoring from timing, Dutch P2P wording, reimbursement-category filing and size
// a repayment is never much more than what it repays

/** P2P repayment vocabulary Dutch banks stamp on transfers */
const REPAY_WORDS = /tikkie|betaalverzoek|payment request|terugbetaling|terugstorting/i;

const DAY_MS = 86_400_000;
const dayDiff = (fromIso: string, toIso: string): number => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS);

const REIMB_CAT_IDS = new Set<string>([EXPECTED_REIMBURSE_ID, RECEIVED_REIMBURSE_ID]);

type ReimbRow = Pick<TransactionRow, 'catId' | 'cats' | 'splits' | 'amountCents' | 'reimbursements'>;

export function filedAsReimbursement(tx: Pick<TransactionRow, 'catId' | 'cats' | 'splits'>): boolean {
  if (tx.catId && REIMB_CAT_IDS.has(tx.catId)) return true;
  return [...(tx.splits ?? []), ...(tx.cats ?? [])].some((s) => REIMB_CAT_IDS.has(s.catId));
}

const reimbSliceCents = (slices: readonly { catId: string; amountCents: number }[] | undefined): number | null => {
  const hits = (slices ?? []).filter((s) => REIMB_CAT_IDS.has(s.catId));
  return hits.length > 0 ? hits.reduce((sum, s) => sum + Math.abs(s.amountCents), 0) : null;
};

/** a part's own cats' slice once a settle has written them, else the whole part when it is filed so */
export function partEarmarkCents(part: Pick<TxSplit, 'catId' | 'cats' | 'amountCents'>): number | null {
  const inner = reimbSliceCents(part.cats);
  if (inner !== null) return inner;
  return REIMB_CAT_IDS.has(part.catId) ? Math.abs(part.amountCents) : null;
}

// NET of what was settled: a settle moves linked cents out of the expected/received slice into `reimbursed`
// so the slice left IS what is still expected; callers must not subtract the links again (a second link defaulted too low)
// null when the row carries no reimbursement bookkeeping: callers fall back to the open value
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

export function partOpenCents(row: Pick<TransactionRow, 'reimbursements'>, part: Pick<TxSplit, 'id' | 'amountCents'>): number {
  return Math.max(
    0,
    Math.abs(part.amountCents) - (row.reimbursements ?? []).filter((r) => r.partId === part.id).reduce((sum, r) => sum + r.amountCents, 0),
  );
}

// the default amount of a link: the open value capped by the earmark, which is already net of the settle
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

// a credit's received-reimbursement slice funds links, its groceries slice never does; `given` is not subtracted again
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

// direction follows the anchor's sign: an expense looks forward at credits, a credit back at expenses
// only a score of at least 4 qualifies: one weak signal alone never makes a suggestion
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
