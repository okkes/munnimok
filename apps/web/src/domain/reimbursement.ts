import type { TransactionRow, TxReimbursement } from '@/db/types';

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

/** cents of the credit not yet promised to any expense */
export function creditRemainingCents(tx: Pick<TransactionRow, 'amountCents'>, given: number): number {
  return Math.max(0, tx.amountCents - given);
}
