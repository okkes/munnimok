import { describe, expect, it } from 'vitest';
import { filedAsReimbursement, reimbEarmarkCents, suggestCounterparts, creditGiveableCents, expenseNeedCents, partEarmarkCents } from './reimburseMatch';
import type { TransactionRow } from '@/db/types';

const tx = (over: Partial<TransactionRow>): TransactionRow =>
  ({
    id: over.id ?? 'x',
    spaceId: 's',
    accountId: 'a',
    date: '2026-07-01',
    amountCents: -5_000,
    currency: 'EUR',
    merchant: 'Shop',
    needsReview: 0,
    deleted: 0,
    ...over,
  }) as TransactionRow;

const noGiven = () => 0;

describe('reimbursement suggestions', () => {
  const expense = tx({ id: 'e', amountCents: -8_000, date: '2026-07-01', merchant: 'Restaurant' });

  it('surfaces the credit that repays the expense: wording + timing + size', () => {
    const match = tx({ id: 'c1', amountCents: 4_000, date: '2026-07-03', merchant: 'Tikkie J. Jansen' });
    const noise = tx({ id: 'c2', amountCents: 4_000, date: '2026-03-01', merchant: 'Salary' });
    const scored = suggestCounterparts(expense, [noise, match], noGiven);
    expect(scored.map((s) => s.tx.id)).toEqual(['c1']);
  });

  it('a credit far bigger than the expense never suggests itself on size', () => {
    const oversized = tx({ id: 'big', amountCents: 500_000, date: '2026-07-02', merchant: 'Employer BV' });
    expect(suggestCounterparts(expense, [oversized], noGiven)).toEqual([]);
  });

  it('rows filed under the reimbursement categories qualify on bookkeeping + timing', () => {
    const filed = tx({ id: 'f', amountCents: 8_000, date: '2026-07-05', merchant: 'J Doe', catId: 'reimburse' });
    const scored = suggestCounterparts(expense, [filed], noGiven);
    expect(scored).toHaveLength(1);
    expect(scored[0].tx.id).toBe('f');
  });

  it('caps at the two best candidates', () => {
    const many = [1, 2, 3, 4].map((i) =>
      tx({ id: `c${i}`, amountCents: 8_000, date: '2026-07-02', merchant: `Betaalverzoek ${i}` }),
    );
    expect(suggestCounterparts(expense, many, noGiven)).toHaveLength(2);
  });

  it('a credit anchor looks BACK at expenses', () => {
    const credit = tx({ id: 'c', amountCents: 3_000, date: '2026-07-08', merchant: 'Tikkie terug' });
    const before = tx({ id: 'e1', amountCents: -3_000, date: '2026-07-05', merchant: 'Dinner' });
    const after = tx({ id: 'e2', amountCents: -3_000, date: '2026-08-20', merchant: 'Dinner' });
    const scored = suggestCounterparts(credit, [before, after], noGiven);
    expect(scored.map((s) => s.tx.id)).toEqual(['e1']);
  });
});

describe('reimbursement earmarks', () => {
  it('a split earmarks its expected/received slice value', () => {
    const row = tx({
      splits: [
        { catId: 'groceries', amountCents: 6_000 },
        { catId: 'expenseReimburse', amountCents: 2_000 },
      ],
    });
    expect(filedAsReimbursement(row)).toBe(true);
    expect(reimbEarmarkCents(row)).toBe(2_000);
  });

  it('a whole-category reimbursement row earmarks its net value', () => {
    const row = tx({ id: 'c', amountCents: 4_500, catId: 'reimburse' });
    expect(reimbEarmarkCents(row)).toBe(4_500);
  });

  it('rows without reimbursement bookkeeping earmark nothing', () => {
    const row = tx({ catId: 'groceries' });
    expect(filedAsReimbursement(row)).toBe(false);
    expect(reimbEarmarkCents(row)).toBeNull();
  });
});

describe('reimbursement earmarks, net of the settle (user ss 2026-10-06: the second link defaulted too low)', () => {
  it('a row filed whole: the first link needs the whole value, the second only what the settle left', () => {
    const fresh = tx({ amountCents: -5_000, catId: 'expenseReimburse' });
    expect(expenseNeedCents(fresh)).toBe(5_000);
    // after linking 20,00 the settle wrote [expenseReimburse 30,00][reimbursed 20,00]
    const settled = tx({
      amountCents: -5_000,
      catId: 'expenseReimburse',
      reimbursements: [{ txId: 'c', amountCents: 2_000 }],
      cats: [{ catId: 'expenseReimburse', amountCents: 3_000 }, { catId: 'reimbursed', amountCents: 2_000 }],
    });
    expect(reimbEarmarkCents(settled)).toBe(3_000);
    expect(expenseNeedCents(settled)).toBe(3_000);
  });

  it('a credit filed whole gives its whole value first and exactly the rest after a settle - never the rest minus the given', () => {
    const fresh = tx({ id: 'c', amountCents: 5_000, catId: 'reimburse' });
    expect(creditGiveableCents(fresh, 0)).toBe(5_000);
    const settled = tx({
      id: 'c',
      amountCents: 5_000,
      catId: 'reimburse',
      cats: [{ catId: 'reimburse', amountCents: 3_000 }, { catId: 'reimbursed', amountCents: 2_000 }],
    });
    expect(creditGiveableCents(settled, 2_000)).toBe(3_000);
    // an uncategorized credit (it self-files on the first link) gives its open value
    expect(creditGiveableCents(tx({ id: 'u', amountCents: 4_000, catId: 'uncategorized' }), 1_000)).toBe(3_000);
  });

  it('a part answers through its own cats once settled, and a part anchor needs its own open value, not the container\'s', () => {
    const row = tx({
      amountCents: -9_000,
      catId: 'restaurants',
      reimbursements: [{ txId: 'c', amountCents: 500, partId: 'p2' }],
      splits: [
        { id: 'p1', catId: 'restaurants', amountCents: 6_000 },
        { id: 'p2', catId: 'expenseReimburse', amountCents: 3_000, cats: [{ catId: 'expenseReimburse', amountCents: 2_500 }, { catId: 'reimbursed', amountCents: 500 }] },
      ],
    });
    expect(partEarmarkCents(row.splits![1])).toBe(2_500);
    expect(partEarmarkCents(row.splits![0])).toBeNull();
    expect(reimbEarmarkCents(row)).toBe(2_500);
    expect(expenseNeedCents(row, 'p2')).toBe(2_500);
    expect(expenseNeedCents(row, 'p1')).toBe(6_000);
    // a container filed as reimbursement whose parts say otherwise earmarks nothing
    expect(reimbEarmarkCents(tx({ amountCents: -9_000, catId: 'expenseReimburse', splits: [{ id: 'q', catId: 'groceries', amountCents: 9_000 }] }))).toBeNull();
  });
});
