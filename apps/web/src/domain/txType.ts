import { autoSubFor } from './categories';
import type { AccountType, TxType } from '@/db/types';

export const ALL_TX_TYPES: TxType[] = [
  'expense',
  'income',
  'saving',
  'transfer',
  'debtPayment',
  'investment',
  'funding',
  'adjustment',
];

/**
 * R1 (typed-splits v2, user 2026-08-05): special accounts STAMP every
 * one of their rows' type — a savings account's ledger is all saving,
 * a loan's all debt, a brokerage's all investment; the sign reads the
 * direction. Credit is deliberately NOT stamped: its feed rows are
 * ordinary purchases, its top-up legs stay transfers (2026-07-17
 * ruling), and trackAsDebt keeps the debts screen opt-in.
 */
export function accountStamp(accountType: AccountType | undefined): TxType | undefined {
  switch (accountType) {
    case 'savings':
      return 'saving';
    case 'mortgage':
    case 'loan':
      return 'debtPayment';
    case 'brokerage':
      return 'investment';
    default:
      return undefined;
  }
}

/**
 * R2 (typed-splits v2, user 2026-08-05 — the inversion): a row linked
 * to ANY tracked counter-account is a TRANSFER; the special meaning
 * (saving, debt payment, investment) now lives on the counter leg,
 * stamped by that account's own type. Before this, the source row wore
 * the family member — that made the checking side carry the story and
 * the special account's own ledger stay empty.
 */
export function typeForLinkedAccount(_accountType: AccountType): TxType {
  return 'transfer';
}

/** category supports a type only if it's one of its declared txTypes */
export function categoryConflictsWithType(catTxTypes: TxType[], txType: TxType): boolean {
  return catTxTypes.length > 0 && !catTxTypes.includes(txType);
}

/**
 * Fields to write when the user changes the type or the linked account.
 * A conflicting category falls back to uncategorized (flagged for review)
 * instead of silently lying about what kind of money movement this is —
 * except transfer-family types (arc 2 locked doors): with the money's
 * sign known they file the family's locked sub, which is always truthful,
 * so no review round-trip. needsReview stays untouched on that path: a
 * row already in the deck keeps its confirmation stop, a settled row
 * isn't dragged back.
 */
export function applyTypeChange(options: {
  nextType: TxType;
  linkedAccountId: string | null;
  currentCatId: string | undefined;
  catTxTypes: TxType[];
  amountCents?: number;
}): { txType: TxType; linkedAccountId?: string; catId?: string; needsReview?: 0 | 1 } {
  const conflict = categoryConflictsWithType(options.catTxTypes, options.nextType);
  const familySub = options.amountCents === undefined ? undefined : autoSubFor(options.nextType, options.amountCents);
  const placeholder = !options.currentCatId || options.currentCatId === 'uncategorized';
  if (familySub && (conflict || placeholder)) {
    return { txType: options.nextType, linkedAccountId: options.linkedAccountId ?? undefined, catId: familySub };
  }
  return {
    txType: options.nextType,
    linkedAccountId: options.linkedAccountId ?? undefined,
    ...(conflict ? { catId: 'uncategorized', needsReview: 1 as const } : {}),
  };
}
