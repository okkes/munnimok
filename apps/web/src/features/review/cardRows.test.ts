import { describe, expect, it } from 'vitest';
import { cardRowGates } from './cardRows';

const open = { recurringOwnsCategory: false, loanCounter: false };

describe('#565 the card rows a filing can use (the rest stand disabled)', () => {
  it('#525: before any category the counterparty and the recurring cost are both open — linking one files the category', () => {
    expect(cardRowGates({ catId: undefined, txType: 'expense' }, open)).toEqual({ counter: true, recurring: true, event: true });
    expect(cardRowGates({ catId: 'uncategorized', txType: 'expense' }, open)).toEqual({ counter: true, recurring: true, event: true });
  });

  it('#339: an ordinary category has no counterparty — predicted or picked alike', () => {
    expect(cardRowGates({ catId: 'groceries', txType: 'expense' }, open)).toEqual({ counter: false, recurring: true, event: true });
  });

  it('#339: a savings move takes its counterparty but no event', () => {
    expect(cardRowGates({ catId: 'savingDeposit', txType: 'saving' }, open)).toEqual({ counter: true, recurring: true, event: false });
  });

  it('a debt payment is never a recurring cost, linked to its loan or not yet', () => {
    expect(cardRowGates({ catId: 'loanRepayment', txType: 'debtPayment' }, open).recurring).toBe(false);
    expect(cardRowGates({ catId: 'groceries', txType: 'expense' }, { ...open, loanCounter: true }).recurring).toBe(false);
  });

  it('a recurring cost owns the category, so the counterparty stays shut; an adjustment takes nothing', () => {
    expect(cardRowGates({ catId: 'groceries', txType: 'expense' }, { ...open, recurringOwnsCategory: true }).counter).toBe(false);
    expect(cardRowGates({ catId: 'adjustment', txType: 'adjustment' }, open)).toEqual({ counter: false, recurring: false, event: false });
  });
});
