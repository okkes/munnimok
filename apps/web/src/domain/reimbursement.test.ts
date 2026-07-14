import { describe, expect, it } from 'vitest';
import {
  clampReimbursement,
  creditRemainingCents,
  givenCents,
  netAmountCents,
  netCreditCents,
  remainingCents,
  totalReimbursedCents,
  withLink,
} from './reimbursement';

const expense = (amountCents: number, reimbursements?: { txId: string; amountCents: number }[]) => ({
  amountCents,
  reimbursements,
});

describe('reimbursement math', () => {
  it('sums totals; empty and missing are zero', () => {
    expect(totalReimbursedCents(expense(-1000))).toBe(0);
    expect(totalReimbursedCents(expense(-1000, []))).toBe(0);
    expect(totalReimbursedCents(expense(-1000, [{ txId: 'a', amountCents: 300 }, { txId: 'b', amountCents: 200 }]))).toBe(500);
  });

  it('net amount moves toward zero, never past it', () => {
    expect(netAmountCents(expense(-1000))).toBe(-1000);
    expect(netAmountCents(expense(-1000, [{ txId: 'a', amountCents: 400 }]))).toBe(-600);
    expect(netAmountCents(expense(-1000, [{ txId: 'a', amountCents: 1000 }]))).toBe(0);
    // corrupted over-reimbursement still cannot flip an expense into income
    expect(netAmountCents(expense(-1000, [{ txId: 'a', amountCents: 1500 }]))).toBe(0);
  });

  it('net amount of income/credit rows is untouched', () => {
    expect(netAmountCents(expense(2200))).toBe(2200);
  });

  it('the credit side derives what it gave and what it is still worth', () => {
    const all = [
      expense(-1000, [{ txId: 'credit-1', amountCents: 400 }]),
      expense(-500, [{ txId: 'credit-1', amountCents: 500 }, { txId: 'other', amountCents: 100 }]),
      expense(2200), // credits carry no links themselves
    ];
    expect(givenCents(all, 'credit-1')).toBe(900);
    expect(givenCents(all, 'unknown')).toBe(0);
    // a €10.10 refund that settled €9 of expenses is worth €1.10 now
    expect(netCreditCents(expense(1010), 900)).toBe(110);
    expect(netCreditCents(expense(900), 900)).toBe(0);
    expect(netCreditCents(expense(900), 1200)).toBe(0); // never negative
    expect(netCreditCents(expense(-500), 0)).toBe(-500); // expenses pass through
    expect(creditRemainingCents(expense(1010), 900)).toBe(110);
  });

  it('remaining shrinks with links and never goes negative', () => {
    expect(remainingCents(expense(-1000))).toBe(1000);
    expect(remainingCents(expense(-1000, [{ txId: 'a', amountCents: 999 }]))).toBe(1);
    expect(remainingCents(expense(-1000, [{ txId: 'a', amountCents: 1500 }]))).toBe(0);
    expect(remainingCents(expense(500))).toBe(0);
  });

  it('clamps to the smallest of request, remainder, credit size', () => {
    expect(clampReimbursement(expense(-1000), 400, 999)).toBe(400); // credit caps
    expect(clampReimbursement(expense(-300), 400, 999)).toBe(300); // remainder caps
    expect(clampReimbursement(expense(-1000), 400, 250)).toBe(250); // request caps
    expect(clampReimbursement(expense(-1000, [{ txId: 'a', amountCents: 900 }]), 400, 400)).toBe(100);
  });

  it('refuses impossible links', () => {
    expect(clampReimbursement(expense(500), 400, 400)).toBe(0); // not an expense
    expect(clampReimbursement(expense(-1000), -50, 400)).toBe(0); // not a credit
    expect(clampReimbursement(expense(-1000), 400, 0)).toBe(0); // nothing requested
    expect(clampReimbursement(expense(-1000, [{ txId: 'a', amountCents: 1000 }]), 400, 100)).toBe(0); // fully reimbursed
  });

  it('withLink adds, replaces, and removes', () => {
    const one = withLink(undefined, 'a', 300);
    expect(one).toEqual([{ txId: 'a', amountCents: 300 }]);
    const replaced = withLink(one, 'a', 200);
    expect(replaced).toEqual([{ txId: 'a', amountCents: 200 }]);
    const two = withLink(replaced, 'b', 100);
    expect(two).toHaveLength(2);
    expect(withLink(two, 'a', 0)).toEqual([{ txId: 'b', amountCents: 100 }]);
  });
});
