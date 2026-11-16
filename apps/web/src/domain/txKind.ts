import type { TxType } from '@/db/types';

// stored types stay the truth; the UI collapses them: standard (income/expense by sign), adjustment, and transfer
// (strictly between two tracked accounts: counterparty mandatory (R2); the special meaning is stamped on the counter leg)
// money leaving to the outside world is always standard; 'funding' derives from a funding-pot counterparty (#152)
export type TxKind = 'standard' | 'transfer' | 'adjustment';

export const TX_KINDS: readonly TxKind[] = ['standard', 'transfer', 'adjustment'];

/** saving/debt/investment are the stamped types of special-account rows (R1); plain 'transfer' is the regular-side leg */
export const TRANSFER_TYPES: readonly TxType[] = ['transfer', 'saving', 'debtPayment', 'investment'];

export function kindOf(txType: TxType): TxKind {
  if (txType === 'adjustment') return 'adjustment';
  return TRANSFER_TYPES.includes(txType) ? 'transfer' : 'standard';
}

export const standardTypeFor = (amountCents: number): TxType => (amountCents < 0 ? 'expense' : 'income');
