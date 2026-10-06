import { describe, expect, it } from 'vitest';
import type { AccountRow, TxView } from '@/db/types';
import { categoryBreakdown, collapsePairedLegs, contributionCents, overviewSummary, overviewSummarySeries, txsForCategory, txsForKind } from './overview';
import { inPeriod, periodHistory, periodHistoryCovering } from './periods';

const PERIOD = { start: '2026-07-01', end: '2026-07-31' };

const tx = (partial: Partial<TxView>): TxView =>
  ({
    id: Math.random().toString(36).slice(2),
    spaceId: 's',
    accountId: 'checking',
    date: '2026-07-10',
    amountCents: -1000,
    currency: 'EUR',
    merchant: 'M',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    fieldVersions: {},
    ...partial,
  }) as TxView;

const accounts = new Map<string, AccountRow>([
  ['checking', { id: 'checking', type: 'checking' } as AccountRow],
  ['savings', { id: 'savings', type: 'savings' } as AccountRow],
  ['broker', { id: 'broker', type: 'brokerage' } as AccountRow],
  ['loan', { id: 'loan', type: 'loan' } as AccountRow],
]);

describe('collapsePairedLegs (user ss 2026-10-06: Debt Payment counted both legs of every repayment)', () => {
  const debtCatalog = {
    byId: (id: string | undefined) => (id === 'loanRepayment' ? { id: 'loanRepayment', parentId: 'debt' } : { id: id ?? 'uncategorized' }),
  };
  const repayment = (id: string, accountId: string, amountCents: number, peer?: string) =>
    tx({ id, accountId, amountCents, txType: 'debtPayment', catId: 'loanRepayment', ...(peer ? { transferPeerId: peer } : {}) });

  it('a pair filed Repaid on both legs counts once, by the loan ledger\'s leg; the other leg is its counterpart', () => {
    const txs = [repayment('in', 'loan', 5_208, 'out'), repayment('out', 'checking', -5_208)];
    const { kept, counterparts } = collapsePairedLegs('debt', txs, accounts);
    expect(kept.map((t) => t.id)).toEqual(['in']);
    expect(counterparts.get('in')?.id).toBe('out');
    // the total and the drill agree with it
    expect(overviewSummary(txs, accounts, PERIOD).debtCents).toBe(5_208);
    const drill = txsForCategory('debt', txs, accounts, PERIOD, 'debt', debtCatalog);
    expect(drill.totalCents).toBe(5_208);
    expect(drill.txs.map((t) => t.id)).toEqual(['in']);
    expect(drill.counterparts.get('in')?.id).toBe('out');
  });

  it('the link may point either way; without a stamped ledger the positive leg wins; an unlinked leg stays', () => {
    const backwards = [repayment('in2', 'loan', 6_324), repayment('out2', 'checking', -6_324, 'in2')];
    expect(collapsePairedLegs('debt', backwards, accounts).kept.map((t) => t.id)).toEqual(['in2']);
    const unstamped = [repayment('a', 'checking', 1_000, 'b'), repayment('b', 'checking', -1_000)];
    expect(collapsePairedLegs('debt', unstamped, accounts).kept.map((t) => t.id)).toEqual(['a']);
    const lone = [repayment('solo', 'checking', -5_520)];
    expect(collapsePairedLegs('debt', lone, accounts).kept.map((t) => t.id)).toEqual(['solo']);
    expect(overviewSummary(lone, accounts, PERIOD).debtCents).toBe(5_520);
  });

  it('income and expense are left alone: a pair there is a mislabelled transfer, the person\'s to fix', () => {
    const txs = [tx({ id: 'x', amountCents: -2_000, transferPeerId: 'y' }), tx({ id: 'y', amountCents: 2_000, txType: 'income' })];
    expect(collapsePairedLegs('expense', txs, accounts).kept).toHaveLength(2);
  });
});

describe('periodHistory', () => {
  it('monthly periods start on the configured day', () => {
    const periods = periodHistory('month', 20, 3, new Date(2026, 6, 7)); // 7 Jul, before day 20
    expect(periods).toHaveLength(3);
    expect(periods.at(-1)).toEqual({ start: '2026-06-20', end: '2026-07-19' }); // current
    expect(periods[0]).toEqual({ start: '2026-04-20', end: '2026-05-19' });
  });

  it('monthly after the start day rolls into the new period', () => {
    const [current] = periodHistory('month', 5, 1, new Date(2026, 6, 7)); // 7 Jul, after day 5
    expect(current).toEqual({ start: '2026-07-05', end: '2026-08-04' });
  });

  it('weekly periods are Monday-anchored and contiguous', () => {
    const periods = periodHistory('week', 1, 2, new Date(2026, 6, 8)); // Wed 8 Jul 2026
    expect(periods[1]).toEqual({ start: '2026-07-06', end: '2026-07-12' });
    expect(periods[0]).toEqual({ start: '2026-06-29', end: '2026-07-05' });
  });

  it('biweekly periods are 14 days and never drift', () => {
    const [p] = periodHistory('biweekly', 1, 1, new Date(2026, 6, 8));
    const days = (Date.parse(p.end) - Date.parse(p.start)) / 86_400_000 + 1;
    expect(days).toBe(14);
    expect(inPeriod('2026-07-08', p)).toBe(true);
  });

  it('weekly/biweekly periods start on the chosen weekday', () => {
    // periodDay 3 = Wednesday; on Wed 8 Jul 2026 the current week IS 8 Jul…
    const [wed] = periodHistory('week', 3, 1, new Date(2026, 6, 8));
    expect(wed).toEqual({ start: '2026-07-08', end: '2026-07-14' });
    // …and on Tue 7 Jul it is still the week that began the previous Wednesday
    const [prev] = periodHistory('week', 3, 1, new Date(2026, 6, 7));
    expect(prev).toEqual({ start: '2026-07-01', end: '2026-07-07' });
    // sunday-start biweekly stays 14 days on the sunday grid
    const [sun] = periodHistory('biweekly', 7, 1, new Date(2026, 6, 8));
    expect(new Date(sun.start).getDay()).toBe(0); // JS Sunday
    expect((Date.parse(sun.end) - Date.parse(sun.start)) / 86_400_000 + 1).toBe(14);
  });
});

describe('contribution sign mechanics (user spec)', () => {
  it('-400 from checking to savings counts as +400 saved', () => {
    expect(contributionCents('saving', tx({ txType: 'saving', amountCents: -40_000 }))).toBe(40_000);
  });

  it('+400 back from savings counts as -400 saved', () => {
    expect(contributionCents('saving', tx({ txType: 'saving', amountCents: 40_000 }))).toBe(-40_000);
  });

  it('the same reversal applies to investments', () => {
    expect(contributionCents('investment', tx({ txType: 'investment', amountCents: -25_000 }))).toBe(25_000);
    expect(contributionCents('investment', tx({ txType: 'investment', amountCents: 25_000 }))).toBe(-25_000);
  });

  it('spending is positive, income keeps its sign', () => {
    expect(contributionCents('expense', tx({ amountCents: -1250 }))).toBe(1250);
    expect(contributionCents('income', tx({ txType: 'income', amountCents: 200_000 }))).toBe(200_000);
  });
});

describe('overviewSummary', () => {
  it('sums the family buckets from the special CATEGORIES (typed-splits v2, Q6)', () => {
    const txs = [
      tx({ txType: 'income', amountCents: 220_000 }),
      tx({ amountCents: -5_000 }),
      tx({ amountCents: -2_000 }),
      // R3 bare rows on regular accounts: the sub carries the meaning
      tx({ txType: 'saving', catId: 'savingDeposit', amountCents: -40_000 }),
      tx({ txType: 'investment', catId: 'investContribution', amountCents: -25_000 }),
      // -500 into the family pot, +100 taken back: net +400 funded (green)
      // — funding rows are standard-typed since the type retired
      tx({ txType: 'expense', catId: 'fundingOut', amountCents: -50_000 }),
      tx({ txType: 'income', catId: 'fundingIn', amountCents: 10_000 }),
      tx({ txType: 'debtPayment', catId: 'loanRepayment', amountCents: -30_000 }),
      tx({ amountCents: -99_900, date: '2026-06-30' }), // outside period
      tx({ amountCents: -99_900, deleted: 1 } as Partial<TxView>),
    ];
    const summary = overviewSummary(txs, accounts, PERIOD);
    expect(summary).toEqual({
      incomeCents: 220_000, // fundingIn stays OUT of income
      expenseCents: 7_000, // fundingOut stays OUT of spending
      savingCents: 40_000,
      investmentCents: 25_000,
      fundingCents: 40_000,
      debtCents: 30_000,
    });
  });

  it('a linked pair counts once by construction: the transfer leg has no bucket', () => {
    const txs = [
      // both sides attached: the regular leg wears the locked Transfer
      // category (R2), only the stamped side carries the family meaning
      tx({ txType: 'transfer', catId: 'transferOut', amountCents: -40_000, accountId: 'checking' }),
      tx({ txType: 'saving', catId: 'savingDeposit', amountCents: 40_000, accountId: 'savings' }),
      tx({ txType: 'transfer', catId: 'transferOut', amountCents: -25_000, accountId: 'checking' }),
      tx({ txType: 'investment', catId: 'investContribution', amountCents: 25_000, accountId: 'broker' }),
    ];
    const summary = overviewSummary(txs, accounts, PERIOD);
    expect(summary.savingCents).toBe(40_000);
    expect(summary.investmentCents).toBe(25_000);
  });

  it('the approved table on the stamped ledgers: interest counts as Saved, Buy/Sell stay internal', () => {
    const txs = [
      tx({ txType: 'saving', catId: 'savingInterest', amountCents: 52, accountId: 'savings' }),
      tx({ txType: 'saving', catId: 'savingFees', amountCents: -30, accountId: 'savings' }),
      // cash → position inside the brokerage moves no new money
      tx({ txType: 'investment', catId: 'investBuy', amountCents: -9_000, accountId: 'broker' }),
      tx({ txType: 'investment', catId: 'investDividend', amountCents: 700, accountId: 'broker' }),
    ];
    const summary = overviewSummary(txs, accounts, PERIOD);
    expect(summary.savingCents).toBe(22); // +52 interest − 30 fees
    expect(summary.investmentCents).toBe(700); // dividends only
  });
});

describe('categoryBreakdown', () => {
  const catalog = {
    byId: (id: string | undefined) => {
      const known: Record<string, { id: string; parentId?: string }> = {
        groceries: { id: 'groceries', parentId: 'consumption' },
        restaurants: { id: 'restaurants', parentId: 'consumption' },
        gym: { id: 'gym', parentId: 'sport' },
        salary: { id: 'salary', parentId: 'income' },
        reimbursed: { id: 'reimbursed', parentId: 'reimbursement' },
        expenseReimburse: { id: 'expenseReimburse', parentId: 'reimbursement' },
        reimburse: { id: 'reimburse', parentId: 'reimbursement' },
        uncategorized: { id: 'uncategorized' },
      };
      return known[id ?? 'uncategorized'] ?? known.uncategorized;
    },
  };

  it('groups by main category with sorted sub totals', () => {
    const txs = [
      tx({ catId: 'groceries', amountCents: -3_000 }),
      tx({ catId: 'groceries', amountCents: -1_000 }),
      tx({ catId: 'restaurants', amountCents: -6_000 }),
      tx({ catId: 'gym', amountCents: -2_500 }),
    ];
    const groups = categoryBreakdown('expense', txs, accounts, PERIOD, catalog);
    expect(groups.map((g) => g.catId)).toEqual(['consumption', 'sport']);
    expect(groups[0].totalCents).toBe(10_000);
    expect(groups[0].subs.map((s) => s.catId)).toEqual(['restaurants', 'groceries']);
    expect(groups[0].subs[1]).toEqual({ catId: 'groceries', totalCents: 4_000, count: 2 });
  });

  it('kind filtering flows through (income never mixes into expense)', () => {
    const txs = [tx({ txType: 'income', catId: 'groceries', amountCents: 5_000 })];
    expect(categoryBreakdown('expense', txs, accounts, PERIOD, catalog)).toEqual([]);
    expect(txsForKind('income', txs, accounts, PERIOD)).toHaveLength(1);
  });

  it('user ss 2026-10-06: the total and its breakdown read the same slices — settled value out, expected/received listed under Reimbursement', () => {
    const txs = [
      // a dinner partly paid back: 11.38 dining, 23.12 settled by a link — spent counts the dining alone
      tx({ catId: 'restaurants', amountCents: -3_450, cats: [{ catId: 'restaurants', amountCents: 1_138 }, { catId: 'reimbursed', amountCents: 2_312 }] }),
      // a dinner still waiting for its share: the expected part is money out until it settles
      tx({ catId: 'restaurants', amountCents: -3_450, cats: [{ catId: 'restaurants', amountCents: 1_138 }, { catId: 'expenseReimburse', amountCents: 2_312 }] }),
      // the credit that settled the first dinner is not income — it already reduced the spending
      tx({ txType: 'income', catId: 'reimbursed', amountCents: 2_312 }),
      // money that came back without a link IS income, under its own family
      tx({ txType: 'income', catId: 'reimburse', amountCents: 5_000 }),
      tx({ txType: 'income', catId: 'salary', amountCents: 100_000 }),
    ];
    const spent = categoryBreakdown('expense', txs, accounts, PERIOD, catalog);
    const spentTotal = txsForKind('expense', txs, accounts, PERIOD).reduce((sum, t) => sum + contributionCents('expense', t), 0);
    expect(spentTotal).toBe(1_138 + 1_138 + 2_312);
    expect(spent.reduce((sum, g) => sum + g.totalCents, 0)).toBe(spentTotal);
    expect(spent.find((g) => g.catId === 'reimbursement')?.subs).toEqual([{ catId: 'expenseReimburse', totalCents: 2_312, count: 1 }]);
    const earned = categoryBreakdown('income', txs, accounts, PERIOD, catalog);
    const earnedTotal = txsForKind('income', txs, accounts, PERIOD).reduce((sum, t) => sum + contributionCents('income', t), 0);
    expect(earnedTotal).toBe(105_000);
    expect(earned.reduce((sum, g) => sum + g.totalCents, 0)).toBe(earnedTotal);
    expect(earned.map((g) => g.catId)).toEqual(['income', 'reimbursement']);
    expect(overviewSummary(txs, accounts, PERIOD)).toMatchObject({ incomeCents: 105_000, expenseCents: 4_588 });
  });
});

describe('period history (the Periods screen, user 2026-10-06)', () => {
  it('overviewSummarySeries: one summary per period, in the order given', () => {
    const periods = [
      { start: '2026-06-01', end: '2026-06-30' },
      { start: '2026-07-01', end: '2026-07-31' },
    ];
    const txs = [tx({ date: '2026-06-10', amountCents: -2000 }), tx({ date: '2026-07-10', amountCents: -1000 }), tx({ date: '2026-07-12', amountCents: 5000, txType: 'income' })];
    const series = overviewSummarySeries(txs, accounts, periods);
    expect(series.map((s) => s.expenseCents)).toEqual([2000, 1000]);
    expect(series.map((s) => s.incomeCents)).toEqual([0, 5000]);
  });

  it('periodHistoryCovering: reaches back to the earliest date, at least two periods, at most the cap', () => {
    const now = new Date(2026, 9, 6);
    expect(periodHistoryCovering('month', 1, null, { cap: 36 }, now)).toHaveLength(2);
    const back = periodHistoryCovering('month', 1, '2026-03-15', { cap: 36 }, now);
    expect(back[0].start).toBe('2026-03-01');
    expect(back.at(-1)?.start).toBe('2026-10-01');
    expect(periodHistoryCovering('month', 1, '2000-01-01', { cap: 36 }, now)).toHaveLength(36);
    expect(periodHistoryCovering('month', 1, '2030-01-01', { cap: 36 }, now)).toHaveLength(2);
    // a period day in the future of the month: the running period started last month
    const day20 = periodHistoryCovering('month', 20, '2026-09-25', { cap: 36 }, now);
    expect(day20[0].start).toBe('2026-08-20');
    expect(day20[1].start).toBe('2026-09-20');
    expect(day20).toHaveLength(2);
  });
});
