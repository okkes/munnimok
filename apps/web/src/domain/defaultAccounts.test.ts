import { describe, expect, it } from 'vitest';
import { cashWalletId, defaultAccountId, defaultFamilyFor, isRetiredDefault } from './defaultAccounts';

describe('default-account domain', () => {
  it('defaultFamilyFor: the ATM pair pins the cash wallet, families pin their pots, standard cats pin nothing', () => {
    expect(defaultFamilyFor('cashWithdraw')).toBe('cash');
    expect(defaultFamilyFor('cashDeposit')).toBe('cash');
    expect(defaultFamilyFor('savingDeposit')).toBe('saving');
    expect(defaultFamilyFor('loanRepayment')).toBe('debtPayment');
    expect(defaultFamilyFor('investBuy')).toBe('investment');
    expect(defaultFamilyFor('transferOut')).toBe('transfer');
    expect(defaultFamilyFor('transferIn')).toBe('transfer');
    expect(defaultFamilyFor('fundingOut')).toBe('funding');
    expect(defaultFamilyFor('groceries')).toBeNull();
    // the adjustment tree is a correction marker, never a counterparty ask
    expect(defaultFamilyFor('balanceAdjustment')).toBeNull();
    expect(defaultFamilyFor(undefined)).toBeNull();
  });

  it('#546: the cash wallet is the default that stays — every other family default is retired', () => {
    expect(cashWalletId('s1')).toBe(defaultAccountId('s1', 'cash'));
    expect(isRetiredDefault({ defaultFor: 'cash' })).toBe(false);
    expect(isRetiredDefault({ defaultFor: undefined })).toBe(false);
    for (const family of ['saving', 'debtPayment', 'investment', 'transfer', 'funding'] as const) {
      expect(isRetiredDefault({ defaultFor: family })).toBe(true);
    }
  });
});
