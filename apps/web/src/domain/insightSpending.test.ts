import { describe, expect, it } from 'vitest';
import type { TxView } from '@/db/types';
import type { InsightInputs } from './insightModel';
import { categoryDrift, expensiveWeekday, noSpendDays, spendingPace } from './insightSpending';
import { periodHistory } from './periods';
import { addDays } from './recurring';

let seq = 0;
const tx = (partial: Partial<TxView>): TxView =>
  ({
    id: `t${(seq += 1)}`,
    spaceId: 's1',
    accountId: 'main',
    date: '2026-07-05',
    amountCents: -1000,
    currency: 'EUR',
    merchant: 'Albert Heijn',
    catId: 'groceries',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    ...partial,
  }) as TxView;

/** one row per day from `from` to `to`, both counted, unless `skip` says otherwise */
const daily = (from: string, to: string, cents: number | ((day: string) => number), partial: Partial<TxView> = {}, skip?: (day: string) => boolean): TxView[] => {
  const out: TxView[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    if (skip?.(day)) continue;
    const amount = typeof cents === 'number' ? cents : cents(day);
    if (amount !== 0) out.push(tx({ date: day, amountCents: -amount, ...partial }));
  }
  return out;
};

const catalog = {
  byId: (id: string | undefined) => ({ id: id ?? 'uncategorized', parentId: undefined }),
  childrenOf: () => [] as { id: string }[],
};

/** a space counting monthly from the 1st, six complete months and July running */
const inputs = (txs: TxView[], today: string, partial: Partial<InsightInputs> = {}): InsightInputs => {
  const [y, m, d] = today.split('-').map(Number);
  return {
    txs,
    recurrings: [],
    budgets: [],
    loans: [],
    accountsById: new Map(),
    catalog,
    periods: periodHistory('month', 1, 7, new Date(y, m - 1, d, 12)),
    today,
    currency: 'EUR',
    space: { periodType: 'month', periodDay: 1 },
    ...partial,
  };
};

/** salary and rent: the money that frames every month, never "spending" for a habit */
const frame = (): TxView[] =>
  ['2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07'].flatMap((month) => [
    tx({ date: `${month}-01`, amountCents: -100_000, merchant: 'Woonstichting', catId: 'housingRent', recurringId: 'rent' }),
    tx({ date: `${month}-01`, amountCents: -30_000, merchant: 'Spaarrekening', catId: 'savingDeposit', txType: 'saving' }),
  ]);

describe('spending pace', () => {
  const steady = () => daily('2026-01-01', '2026-06-30', 2_000);

  it('a period running far ahead of the usual curve says how much more it ends at', () => {
    const july = daily('2026-07-01', '2026-07-15', 3_500);
    const hits = spendingPace(inputs([...frame(), ...steady(), ...july], '2026-07-15'));
    expect(hits).toHaveLength(1);
    // typical by the 15th: 15 × €20; a typical month: the median of 620/560/620/600/620/600
    expect(hits[0].params.typical).toEqual({ money: 30_000 });
    expect(hits[0].params.usual).toEqual({ money: 61_000 });
    expect(hits[0].params.spent).toEqual({ money: 52_500 });
    // "at this pace": the month keeps the ratio it has now
    expect(hits[0].params.projected).toEqual({ money: Math.round((61_000 * 52_500) / 30_000) });
    expect(hits[0]).toMatchObject({ id: 'pace:2026-07-01', kind: 'pace', severity: 'pattern', impactCents: 106_750 - 61_000 });
    expect(hits[0].chart).toHaveLength(7);
  });

  it('rent, savings and an expected reimbursement never count as spending', () => {
    const july = [
      ...daily('2026-07-01', '2026-07-15', 2_000),
      tx({ date: '2026-07-04', amountCents: -40_000, catId: 'expenseReimburse', merchant: 'Hotel for the team' }),
      tx({ date: '2026-07-05', amountCents: -90_000, catId: 'savingDeposit', txType: 'saving' }),
    ];
    expect(spendingPace(inputs([...frame(), ...steady(), ...july], '2026-07-15'))).toHaveLength(0);
  });

  it('stays quiet early in the period, without three covered periods, or in another currency', () => {
    const fast = daily('2026-07-01', '2026-07-15', 3_500);
    expect(spendingPace(inputs([...frame(), ...steady(), ...fast], '2026-07-04'))).toHaveLength(0);
    // the data starts in May: two complete months only
    const short = daily('2026-05-01', '2026-06-30', 2_000);
    expect(spendingPace(inputs([...short, ...fast], '2026-07-15'))).toHaveLength(0);
    // a fast July on a dollar card is not euros
    const dollars = daily('2026-07-01', '2026-07-15', 3_500, { currency: 'USD' });
    expect(spendingPace(inputs([...frame(), ...steady(), ...daily('2026-07-01', '2026-07-15', 2_000), ...dollars], '2026-07-15'))).toHaveLength(0);
  });
});

describe('category drift', () => {
  /** one shop per month in a category */
  const monthly = (catId: string, amounts: number[], partial: Partial<TxView> = {}) =>
    amounts.map((cents, i) => tx({ date: `2026-0${i + 1}-10`, amountCents: -cents, catId, merchant: catId, ...partial }));

  it('groceries creeping up month after month: the rise, the averages, the door to the category', () => {
    const txs = [...frame(), ...monthly('groceries', [30_000, 31_000, 30_000, 36_000, 37_000, 38_000])];
    const hits = categoryDrift(inputs(txs, '2026-07-12'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'drift:groceries:2026-06-01', kind: 'drift', topic: 'spending', actionTo: '/overview/expense/groceries' });
    expect(hits[0].params).toMatchObject({ cat: { cat: 'groceries' }, pct: 22, from: { money: 30_333 }, to: { money: 37_000 }, n: 6 });
  });

  it('one big month is no trend, and a category missing a month is no habit', () => {
    const spike = monthly('restaurants', [10_000, 10_000, 10_000, 10_000, 10_000, 60_000]);
    const gap = monthly('clothing', [5_000, 0, 5_000, 9_000, 9_500, 10_000]);
    expect(categoryDrift(inputs([...frame(), ...spike, ...gap], '2026-07-12'))).toHaveLength(0);
  });

  it('uncategorized money, what a recurring cost takes, small sums and short histories stay out', () => {
    const rise = [30_000, 31_000, 30_000, 36_000, 37_000, 38_000];
    const uncategorized = monthly('uncategorized', rise);
    const insurance = monthly('insurance', rise, { recurringId: 'ins' });
    const pennies = monthly('sweets', [500, 500, 500, 700, 700, 700]);
    expect(categoryDrift(inputs([...frame(), ...uncategorized, ...insurance, ...pennies], '2026-07-12'))).toHaveLength(0);
    // the data starts in February: five complete months
    expect(categoryDrift(inputs(monthly('groceries', rise).slice(1), '2026-07-12'))).toHaveLength(0);
  });
});

describe('the most expensive weekday', () => {
  // 2026-07-15 is a Wednesday; the window is the twelve weeks before it
  const today = '2026-07-15';
  const from = addDays(today, -84);

  it('Saturday well above the daily average, measured over twelve weeks', () => {
    const saturdays = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() === 6 ? 4_500 : 2_000);
    const hits = expensiveWeekday(inputs([...frame(), ...daily(from, today, saturdays)], today));
    expect(hits).toHaveLength(1);
    // (6 × €20 + €45) / 7 = €23.57; €45 is 91% above it
    expect(hits[0].params).toMatchObject({ weekday: { weekday: 6 }, pct: 91, day: { money: 4_500 }, avg: { money: 2_357 }, weeks: 12 });
    // Monday first: Saturday is the sixth bar
    expect(hits[0].chartFocus).toBe(5);
    // a Sunday-first space starts its chart on Sunday
    const sundayFirst = expensiveWeekday(inputs([...frame(), ...daily(from, today, saturdays)], today, { space: { periodType: 'month', periodDay: 1, weekStart: 'sunday' } }));
    expect(sundayFirst[0].chartFocus).toBe(6);
  });

  it('one big Tuesday is no habit; an even week says nothing; a short history stays quiet', () => {
    const flat = daily(from, today, 2_000);
    const tv = tx({ date: '2026-06-16', amountCents: -200_000, catId: 'electronics', merchant: 'MediaMarkt' });
    expect(expensiveWeekday(inputs([...frame(), ...flat, tv], today))).toHaveLength(0);
    const saturdays = (day: string) => (new Date(`${day}T12:00:00Z`).getUTCDay() === 6 ? 4_500 : 2_000);
    expect(expensiveWeekday(inputs(daily('2026-06-01', today, saturdays), today))).toHaveLength(0);
  });
});

describe('no-spend days', () => {
  /** shopping every day but the 5th, 15th and 25th: three calm days a month */
  const usual = () =>
    daily('2026-02-01', '2026-06-30', 2_000, {}, (day) => ['05', '15', '25'].includes(day.slice(8)));
  const calmInJuly = new Set(['02', '03', '06', '08', '10', '11', '13', '16']);
  const july = () => daily('2026-07-01', '2026-07-19', 2_000, {}, (day) => calmInJuly.has(day.slice(8)));

  it('a record of calm days this period, against the five before', () => {
    // the rent leaves on the 1st by itself — it never breaks a calm day
    const hits = noSpendDays(inputs([...frame(), ...usual(), ...july()], '2026-07-20'));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'nospend:2026-07-01', kind: 'nospend', severity: 'win' });
    expect(hits[0].params).toMatchObject({ n: 8, best: 3, k: 6, prev: 5 });
    expect(hits[0].chart).toEqual([3, 3, 3, 3, 3, 8]);
  });

  it('days after the newest row are not known yet — a feed that has not synced is no calm', () => {
    const stale = july().filter((t) => t.date <= '2026-07-09');
    // up to the 9th only four calm days are known
    expect(noSpendDays(inputs([...frame(), ...usual(), ...stale], '2026-07-20'))).toHaveLength(0);
  });

  it('no record, too few, or too little history: quiet', () => {
    const calmish = daily('2026-07-01', '2026-07-19', 2_000, {}, (day) => ['02', '03'].includes(day.slice(8)));
    expect(noSpendDays(inputs([...frame(), ...usual(), ...calmish], '2026-07-20'))).toHaveLength(0);
    const shortHistory = daily('2026-05-01', '2026-06-30', 2_000, {}, (day) => day.endsWith('5'));
    expect(noSpendDays(inputs([...shortHistory, ...july()], '2026-07-20'))).toHaveLength(0);
  });
});
