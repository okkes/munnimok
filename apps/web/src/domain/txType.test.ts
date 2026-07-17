import { describe, expect, it } from 'vitest';
import { ALL_TX_TYPES, applyTypeChange, categoryConflictsWithType, typeForLinkedAccount } from './txType';
import type { AccountType, TxType } from '@/db/types';

describe('typeForLinkedAccount', () => {
  const cases: [AccountType, TxType][] = [
    ['savings', 'saving'],
    ['credit', 'transfer'], // user ruling: own credit card = transfer
    ['mortgage', 'debtPayment'],
    ['loan', 'debtPayment'],
    ['brokerage', 'investment'],
    ['checking', 'transfer'],
    ['cash', 'transfer'],
  ];
  it.each(cases)('%s account -> %s', (accountType, expected) => {
    expect(typeForLinkedAccount(accountType)).toBe(expected);
  });
});

describe('categoryConflictsWithType', () => {
  it('flags a category that does not support the type', () => {
    expect(categoryConflictsWithType(['expense'], 'saving')).toBe(true);
    expect(categoryConflictsWithType(['expense'], 'expense')).toBe(false);
    expect(categoryConflictsWithType(['saving'], 'saving')).toBe(false);
  });
  it('multi-type and typeless categories never conflict with a matching type', () => {
    expect(categoryConflictsWithType(['income', 'expense'], 'expense')).toBe(false);
    expect(categoryConflictsWithType([], 'transfer')).toBe(false); // universal fallback
  });
});

describe('applyTypeChange', () => {
  it('keeps a compatible category', () => {
    const fields = applyTypeChange({
      nextType: 'expense',
      linkedAccountId: null,
      currentCatId: 'groceries',
      catTxTypes: ['expense'],
    });
    expect(fields).toEqual({ txType: 'expense', linkedAccountId: undefined });
  });

  it('resets a conflicting category to uncategorized and flags review', () => {
    const fields = applyTypeChange({
      nextType: 'transfer',
      linkedAccountId: 'acc-2',
      currentCatId: 'groceries',
      catTxTypes: ['expense'],
    });
    expect(fields).toEqual({
      txType: 'transfer',
      linkedAccountId: 'acc-2',
      catId: 'uncategorized',
      needsReview: 1,
    });
  });

  it('covers every type in the catalog list', () => {
    expect(ALL_TX_TYPES).toHaveLength(7);
    for (const type of ALL_TX_TYPES) {
      expect(applyTypeChange({ nextType: type, linkedAccountId: null, currentCatId: undefined, catTxTypes: [] }).txType).toBe(type);
    }
  });
});
