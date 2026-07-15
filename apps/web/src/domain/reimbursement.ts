import type { TransactionRow, TxReimbursement, TxSplit } from '@/db/types';
import { UNCATEGORIZED_ID } from '@/domain/categories';

/**
 * Reimbursement math. The expense transaction owns the links; amounts are
 * integer cents and always positive. An expense can never be reimbursed
 * beyond its own size, and a credit can never give more than it is worth.
 */

/** total cents already reimbursed against an expense */
export function totalReimbursedCents(tx: Pick<TransactionRow, 'reimbursements'>): number {
  return (tx.reimbursements ?? []).reduce((sum, r) => sum + r.amountCents, 0);
}

/** effective cost after reimbursements (expense stays <= 0) */
export function netAmountCents(tx: Pick<TransactionRow, 'amountCents' | 'reimbursements'>): number {
  if (tx.amountCents >= 0) return tx.amountCents;
  return Math.min(0, tx.amountCents + totalReimbursedCents(tx));
}

/** cents of the expense still open for reimbursement */
export function remainingCents(tx: Pick<TransactionRow, 'amountCents' | 'reimbursements'>): number {
  if (tx.amountCents >= 0) return 0;
  return Math.max(0, Math.abs(tx.amountCents) - totalReimbursedCents(tx));
}

/**
 * Clamp a requested link amount to what is actually possible:
 * bounded by the open remainder of the expense and the size of the credit.
 * Returns 0 when the pair cannot be linked at all.
 */
export function clampReimbursement(
  expense: Pick<TransactionRow, 'amountCents' | 'reimbursements'>,
  creditAmountCents: number,
  requestedCents: number,
): number {
  if (expense.amountCents >= 0 || creditAmountCents <= 0 || requestedCents <= 0) return 0;
  return Math.min(requestedCents, remainingCents(expense), creditAmountCents);
}

/** add or replace the link for one credit tx (one link per credit) */
export function withLink(
  reimbursements: TxReimbursement[] | undefined,
  txId: string,
  amountCents: number,
): TxReimbursement[] {
  const rest = (reimbursements ?? []).filter((r) => r.txId !== txId);
  return amountCents > 0 ? [...rest, { txId, amountCents }] : rest;
}

/**
 * Cents a credit has given away as reimbursements. Derived — the
 * expense rows own the links, the credit carries nothing itself.
 */
export function givenCents(
  allTxs: readonly Pick<TransactionRow, 'reimbursements'>[],
  creditId: string,
): number {
  let sum = 0;
  for (const tx of allTxs) {
    for (const link of tx.reimbursements ?? []) {
      if (link.txId === creditId) sum += link.amountCents;
    }
  }
  return sum;
}

/** what a credit is still worth after refunding elsewhere (income stays >= 0) */
export function netCreditCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  if (tx.amountCents <= 0) return tx.amountCents;
  return Math.max(0, tx.amountCents - given);
}

/** the categories a reimbursement consumes FIRST when it shrinks a
 *  transaction's categorized value (user rule) */
export const REIMB_CAT_IDS = ['expenseReimburse', 'reimburse'];

/**
 * Physically rewrite a transaction's category attribution after its
 * reimbursed value changed (user decision: splits carry the NET truth so
 * every reader — budgets, trends, drill-downs — agrees for free).
 *
 * Shrinking consumes categories in priority order: reimbursement
 * categories first, then uncategorized, then the largest slice (ties
 * alphabetically by name). A slice that hits 0 is removed. Growing back
 * (a link removed/reduced) lands the freed value on "uncategorized" —
 * deliberately NOT the original category, per the user's rule.
 *
 * The result always keeps at least one slice (0-amount when everything
 * is reimbursed): readers fall back to catId × GROSS amount when splits
 * are absent, which would resurrect the pre-reimbursement value.
 */
export function redistributedSplits(
  tx: Pick<TransactionRow, 'amountCents' | 'catId' | 'splits'>,
  targetAbsCents: number,
  nameOf: (catId: string) => string,
): TxSplit[] {
  const primary = tx.catId ?? UNCATEGORIZED_ID;
  const slices: TxSplit[] = tx.splits?.length
    ? tx.splits.map((s) => ({ ...s }))
    : [{ catId: primary, amountCents: Math.abs(tx.amountCents) }];

  const current = slices.reduce((sum, s) => sum + s.amountCents, 0);
  let delta = current - Math.max(0, targetAbsCents);

  if (delta < 0) {
    // value coming back: the freed amount is set to uncategorized
    const uncat = slices.find((s) => s.catId === UNCATEGORIZED_ID);
    if (uncat) uncat.amountCents += -delta;
    else slices.push({ catId: UNCATEGORIZED_ID, amountCents: -delta });
  } else if (delta > 0) {
    const takeFrom = (slice: TxSplit | undefined) => {
      if (!slice || delta <= 0) return;
      const taken = Math.min(slice.amountCents, delta);
      slice.amountCents -= taken;
      delta -= taken;
    };
    for (const id of REIMB_CAT_IDS) takeFrom(slices.find((s) => s.catId === id));
    takeFrom(slices.find((s) => s.catId === UNCATEGORIZED_ID));
    while (delta > 0) {
      const candidates = slices.filter((s) => s.amountCents > 0);
      if (candidates.length === 0) break;
      candidates.sort((a, b) => b.amountCents - a.amountCents || nameOf(a.catId).localeCompare(nameOf(b.catId)));
      takeFrom(candidates[0]);
    }
  }

  const kept = slices.filter((s) => s.amountCents > 0);
  return kept.length > 0 ? kept : [{ catId: primary, amountCents: 0 }];
}

/** cents of the credit not yet promised to any expense */
export function creditRemainingCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  return Math.max(0, tx.amountCents - given);
}
