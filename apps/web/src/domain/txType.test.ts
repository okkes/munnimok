import { describe, expect, it } from 'vitest';
import { ALL_TX_TYPES, accountStamp, applyTypeChange, categoryConflictsWithType, typeForLinkedAccount } from './txType';
import type { AccountType, TxType } from '@/db/types';

describe('typeForLinkedAccount (R2 inversion, 2026-08-05)', () => {
  // ANY tracked counterparty makes the source leg a plain transfer —
  // the special meaning lives on the counter account's own ledger now
  const cases: AccountType[] = ['savings', 'credit', 'mortgage', 'loan', 'brokerage', 'checking', 'cash'];
  it.each(cases)('%s account -> transfer', (accountType) => {
    expect(typeForLinkedAccount(accountType)).toBe('transfer');
  });
});

describe('accountStamp (R1)', () => {
  const cases: [AccountType, TxType | undefined][] = [
    ['savings', 'saving'],
    ['mortgage', 'debtPayment'],
    ['loan', 'debtPayment'],
    ['brokerage', 'investment'],
    // credit deliberately unstamped: its feed rows are purchases
    ['credit', undefined],
    ['checking', undefined],
    ['cash', undefined],
  ];
  it.each(cases)('%s account -> %s', (accountType, expected) => {
    expect(accountStamp(accountType)).toBe(expected);
  });
  it('no account, no stamp', () => {
    expect(accountStamp(undefined)).toBeUndefined();
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
    expect(ALL_TX_TYPES).toHaveLength(8); // + funding (2026-08-01)
    for (const type of ALL_TX_TYPES) {
      expect(applyTypeChange({ nextType: type, linkedAccountId: null, currentCatId: undefined, catTxTypes: [] }).txType).toBe(type);
    }
  });

  describe('the locked family sub at the write edge (arc 2)', () => {
    it('a conflicting category files the sign-picked sub instead of review', () => {
      const fields = applyTypeChange({
        nextType: 'transfer',
        linkedAccountId: 'acc-2',
        currentCatId: 'groceries',
        catTxTypes: ['expense'],
        amountCents: -5000,
      });
      expect(fields).toEqual({ txType: 'transfer', linkedAccountId: 'acc-2', catId: 'transferOut' });
    });

    it('a placeholder category files too — both signs', () => {
      const bare = { linkedAccountId: null, catTxTypes: [] as TxType[] };
      expect(applyTypeChange({ ...bare, nextType: 'saving', currentCatId: undefined, amountCents: -100 }).catId).toBe('savingDeposit');
      expect(applyTypeChange({ ...bare, nextType: 'saving', currentCatId: 'uncategorized', amountCents: 100 }).catId).toBe('savingWithdraw');
      expect(applyTypeChange({ ...bare, nextType: 'debtPayment', currentCatId: undefined, amountCents: -100 }).catId).toBe('loanRepayment');
    });

    it('a deliberate compatible category survives; standard types never file', () => {
      const kept = applyTypeChange({
        nextType: 'saving',
        linkedAccountId: 'acc-2',
        currentCatId: 'savingWithdraw',
        catTxTypes: ['saving'],
        amountCents: -100,
      });
      expect(kept.catId).toBeUndefined();
      const standard = applyTypeChange({
        nextType: 'expense',
        linkedAccountId: null,
        currentCatId: undefined,
        catTxTypes: [],
        amountCents: -100,
      });
      expect(standard.catId).toBeUndefined();
    });

    it('without the sign the old review fallback stands', () => {
      const fields = applyTypeChange({
        nextType: 'transfer',
        linkedAccountId: 'acc-2',
        currentCatId: 'groceries',
        catTxTypes: ['expense'],
      });
      expect(fields.catId).toBe('uncategorized');
      expect(fields.needsReview).toBe(1);
    });
  });
});
