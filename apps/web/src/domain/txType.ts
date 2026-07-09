import type { AccountType, TxType } from '@/db/types';

export const ALL_TX_TYPES: TxType[] = [
  'expense',
  'income',
  'saving',
  'transfer',
  'debtPayment',
  'investment',
  'adjustment',
];

/**
 * When a transaction is linked to a counter-account, its type is derived
 * from what that account IS — moving money to savings is a saving, paying
 * a credit card is a debt payment — and can't be chosen freely.
 */
export function typeForLinkedAccount(accountType: AccountType): TxType {
  switch (accountType) {
    case 'savings':
      return 'saving';
    case 'credit':
    case 'mortgage':
    case 'loan':
      return 'debtPayment';
    case 'brokerage':
      return 'investment';
    case 'checking':
    case 'cash':
      return 'transfer';
  }
}

/** category supports a type only if it's one of its declared txTypes */
export function categoryConflictsWithType(catTxTypes: TxType[], txType: TxType): boolean {
  return catTxTypes.length > 0 && !catTxTypes.includes(txType);
}

/**
 * Fields to write when the user changes the type or the linked account.
 * A conflicting category falls back to uncategorized (flagged for review)
 * instead of silently lying about what kind of money movement this is.
 */
export function applyTypeChange(options: {
  nextType: TxType;
  linkedAccountId: string | null;
  currentCatId: string | undefined;
  catTxTypes: TxType[];
}): { txType: TxType; linkedAccountId?: string; catId?: string; needsReview?: 0 | 1 } {
  const conflict = categoryConflictsWithType(options.catTxTypes, options.nextType);
  return {
    txType: options.nextType,
    linkedAccountId: options.linkedAccountId ?? undefined,
    ...(conflict ? { catId: 'uncategorized', needsReview: 1 as const } : {}),
  };
}
