import { describe, expect, it } from 'vitest';
import {
  clampReimbursement,
  creditRemainingCents,
  givenCents,
  netAmountCents,
  redistributedSplits,
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

describe('redistributedSplits (physical rewrite, user rules)', () => {
  const names: Record<string, string> = { groceries: 'Groceries', eatingOut: 'Eating out', fun: 'Fun', reimburse: 'Reimbursement', expenseReimburse: 'Expected reimbursement', uncategorized: 'Uncategorized', transferIn: 'Transfer In' };
  const nameOf = (id: string) => names[id] ?? id;

  it('a non-split credit shrinks to its net value in its own category', () => {
    const out = redistributedSplits({ amountCents: 10_000, catId: 'transferIn', splits: undefined }, 5_000, nameOf);
    expect(out).toEqual([{ catId: 'transferIn', amountCents: 5_000 }]);
  });

  it('consumes reimbursement categories first, then uncategorized, then the largest', () => {
    const tx = {
      amountCents: -10_000,
      catId: 'groceries',
      splits: [
        { catId: 'groceries', amountCents: 4_000 },
        { catId: 'expenseReimburse', amountCents: 2_000 },
        { catId: 'uncategorized', amountCents: 1_000 },
        { catId: 'fun', amountCents: 3_000 },
      ],
    };
    // reduce by 3500: 2000 reimb + 1000 uncat + 500 from groceries (largest)
    const out = redistributedSplits(tx, 6_500, nameOf);
    expect(out).toEqual([
      { catId: 'groceries', amountCents: 3_500 },
      { catId: 'fun', amountCents: 3_000 },
    ]);
  });

  it('largest-first with alphabetical tie-break, zeroed slices removed', () => {
    const tx = {
      amountCents: -6_000,
      catId: 'groceries',
      splits: [
        { catId: 'fun', amountCents: 3_000 },
        { catId: 'eatingOut', amountCents: 3_000 },
      ],
    };
    // tie at 3000: "Eating out" < "Fun" alphabetically → consumed first
    const out = redistributedSplits(tx, 2_000, nameOf);
    expect(out).toEqual([{ catId: 'fun', amountCents: 2_000 }]);
  });

  it('keeps a zero slice when fully reimbursed (readers must not fall back to gross)', () => {
    const out = redistributedSplits({ amountCents: -4_000, catId: 'groceries', splits: undefined }, 0, nameOf);
    expect(out).toEqual([{ catId: 'groceries', amountCents: 0 }]);
  });

  it('a removed reimbursement frees value onto uncategorized, never the original category', () => {
    const tx = { amountCents: 10_000, catId: 'transferIn', splits: [{ catId: 'transferIn', amountCents: 5_000 }] };
    const out = redistributedSplits(tx, 10_000, nameOf);
    expect(out).toEqual([
      { catId: 'transferIn', amountCents: 5_000 },
      { catId: 'uncategorized', amountCents: 5_000 },
    ]);
  });
});
