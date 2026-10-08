import { describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog';
import {
  balanceProjection,
  cashflowSeries,
  categorySeries,
  cumulativeByDay,
  dailyBalanceSeries,
  dayIndexOf,
  expenseSeries,
  finishedAverage,
  incomeSpikes,
  localDate,
  median,
  netWorthSeries,
  periodBalanceRange,
  periodDays,
  periodLabel,
  sameDayComparison,
  scopeIds,
  scopedBreakdown,
  scopedContribution,
  trendLabels,
} from './trends';
import type { RecurringRow, TxView } from '@/db/types';

const tx = (over: Partial<TxView>): TxView => ({
  id: Math.random().toString(36).slice(2),
  spaceId: 's1',
  accountId: 'a1',
  date: '2026-06-10',
  amountCents: -1000,
  currency: 'EUR',
  merchant: 'X',
  txType: 'expense',
  needsReview: 0,
  fieldVersions: {},
  deleted: 0,
  ...over,
});

const rec = (over: Partial<RecurringRow>): RecurringRow => ({
  id: Math.random().toString(36).slice(2),
  spaceId: 's1',
  name: 'R',
  kind: 'fixed',
  amountCents: 1000,
  every: 'month',
  dueDay: 15,
  active: 1,
  fieldVersions: {},
  deleted: 0,
  ...over,
});

const periods = [
  { start: '2026-05-01', end: '2026-05-31' },
  { start: '2026-06-01', end: '2026-06-30' },
];
const catalog = buildCatalog([], false);

describe('categorySeries', () => {
  it('buckets net expenses per period, all categories by default', () => {
    const txs = [
      tx({ date: '2026-05-05', amountCents: -2000 }),
      tx({ date: '2026-06-05', amountCents: -1000, reimbursements: [{ txId: 'r', amountCents: 400 }] }),
      tx({ date: '2026-06-06', amountCents: 5000, txType: 'income' }), // not an expense
      tx({ date: '2026-06-07', amountCents: -999, pending: 1 }), // reservation noise
    ];
    expect(categorySeries(txs, periods, catalog)).toEqual([2000, 600]);
  });

  it('a main covers its subs; category spreads and parts count toward their own category (#211)', () => {
    const txs = [
      tx({ date: '2026-06-05', catId: 'groceries', amountCents: -1500 }),
      tx({ date: '2026-06-06', catId: 'gym', amountCents: -3000 }), // sport, not consumption
      tx({
        // #211: the row's OWN spread — one transaction, two categories
        date: '2026-06-07',
        catId: 'consumptionOther',
        amountCents: -1000,
        cats: [
          { catId: 'consumptionOther', amountCents: 700 },
          { catId: 'alcohol', amountCents: 300 },
        ],
      }),
      tx({
        // a real split: only the consumption PART counts here
        date: '2026-06-08',
        catId: 'groceries',
        amountCents: -900,
        splits: [
          { id: 'p1', catId: 'groceries', amountCents: 400 },
          { id: 'p2', catId: 'gym', amountCents: 500, label: 'day pass' },
        ],
      }),
    ];
    // consumption = groceries 1500 + spread 700+300 + part 400
    expect(categorySeries(txs, periods, catalog, 'consumption')).toEqual([0, 2900]);
    expect(categorySeries(txs, periods, catalog, 'groceries')).toEqual([0, 1900]);
  });
});

describe('scopeIds + expenseSeries (custom graphs, user 2026-10-08)', () => {
  it('a graph scope unions mains (with their subs) and lone subs; empty means everything', () => {
    expect(scopeIds(catalog, null)).toBeNull();
    expect(scopeIds(catalog, [])).toBeNull();
    const ids = scopeIds(catalog, ['consumption', 'gym'])!;
    expect(ids.has('consumption')).toBe(true);
    expect(ids.has('groceries')).toBe(true); // a main brings its subs
    expect(ids.has('gym')).toBe(true); // a sub stands for itself
    expect(ids.has('sport')).toBe(false); // …not its parent
  });

  it('expenseSeries sums the scope per period and scopedContribution names a row’s share', () => {
    const txs = [
      tx({ date: '2026-06-05', catId: 'groceries', amountCents: -1500 }),
      tx({ date: '2026-06-06', catId: 'gym', amountCents: -3000 }),
      tx({ date: '2026-06-07', catId: 'subs', amountCents: -400 }),
      tx({ date: '2026-06-08', catId: 'gym', amountCents: -100, pending: 1 }),
    ];
    const ids = scopeIds(catalog, ['consumption', 'gym']);
    expect(expenseSeries(txs, periods, ids)).toEqual([0, 4500]);
    expect(scopedContribution(txs[0], ids)).toBe(1500);
    expect(scopedContribution(txs[2], ids)).toBe(0); // entertainment is outside the scope
    expect(scopedContribution(txs[3], ids)).toBe(0); // pending never counts
  });

  it('scopedBreakdown files each slice under its own category, largest first', () => {
    const txs = [
      tx({ date: '2026-06-05', catId: 'groceries', amountCents: -1500 }),
      tx({ date: '2026-06-06', catId: 'groceries', amountCents: -500 }),
      tx({ date: '2026-06-06', catId: 'coffee', amountCents: -400 }),
      tx({
        date: '2026-06-07',
        catId: 'groceries',
        amountCents: -900,
        splits: [
          { id: 'p1', catId: 'groceries', amountCents: 400 },
          { id: 'p2', catId: 'alcohol', amountCents: 500 },
        ],
      }),
      tx({ date: '2026-06-08', amountCents: -250 }), // uncategorized stays visible
      tx({ date: '2026-06-09', catId: 'gym', amountCents: -3000 }), // outside the scope
    ];
    expect(scopedBreakdown(txs, periods[1], scopeIds(catalog, ['consumption']))).toEqual([
      { catId: 'groceries', cents: 2400 },
      { catId: 'alcohol', cents: 500 },
      { catId: 'coffee', cents: 400 },
    ]);
    expect(scopedBreakdown(txs, periods[1], null).at(-1)).toEqual({ catId: '', cents: 250 });
  });

  it('finishedAverage ignores the running period and empty periods', () => {
    expect(finishedAverage([1000, 0, 3000, 500])).toBe(2000);
    expect(finishedAverage([0, 0, 700])).toBe(0);
  });
});

describe('cumulativeByDay + sameDayComparison (user 2026-10-08)', () => {
  const june = periods[1];
  const txs = [
    tx({ date: '2026-06-01', amountCents: -1000 }),
    tx({ date: '2026-06-03', amountCents: -500 }),
    tx({ date: '2026-06-03', amountCents: -250, catId: 'gym' }),
    tx({ date: '2026-06-30', amountCents: -100 }),
    tx({ date: '2026-07-01', amountCents: -9999 }), // next period
    tx({ date: '2026-05-02', amountCents: -2000 }),
  ];

  it('runs one entry per day of the period, summing as it goes', () => {
    const cumulative = cumulativeByDay(txs, june, null, catalog);
    expect(cumulative).toHaveLength(30);
    expect(cumulative.slice(0, 4)).toEqual([1000, 1000, 1750, 1750]);
    expect(cumulative.at(-1)).toBe(1850);
    // a scope narrows it the same way the period series does
    expect(cumulativeByDay(txs, june, ['gym'], catalog)[2]).toBe(250);
  });

  it('periodDays and dayIndexOf read inclusive bounds', () => {
    expect(periodDays(june)).toBe(30);
    expect(dayIndexOf('2026-06-01', june)).toBe(0);
    expect(dayIndexOf('2026-06-30', june)).toBe(29);
  });

  it('compares every period at the same day-of-period, clamped to a shorter period', () => {
    const points = sameDayComparison(txs, periods, 2, null, catalog);
    expect(points.map((p) => p.cents)).toEqual([2000, 1750]);
    // a day index past a period's end reads its last day
    expect(sameDayComparison(txs, [june], 99, null, catalog)[0].cents).toBe(1850);
  });
});

describe('cashflowSeries', () => {
  it('opposes gross income and net expenses per period', () => {
    const txs = [
      tx({ date: '2026-05-15', amountCents: 220_000, txType: 'income' }),
      tx({ date: '2026-05-20', amountCents: -80_000 }),
      tx({ date: '2026-06-20', amountCents: -50_000, reimbursements: [{ txId: 'r', amountCents: 20_000 }] }),
    ];
    expect(cashflowSeries(txs, periods)).toEqual([
      { incomeCents: 220_000, expenseCents: 80_000, netCents: 140_000 },
      { incomeCents: 0, expenseCents: 30_000, netCents: -30_000 },
    ]);
  });
});

describe('netWorthSeries', () => {
  it('walks the current balance backwards through the transactions', () => {
    const accounts = [
      { id: 'a1', balanceCents: 100_000, archived: 0 as const, deleted: 0 as const },
      { id: 'flat', balanceCents: 50_000, archived: 0 as const, deleted: 0 as const }, // no txs → flat
    ];
    const txs = [
      tx({ date: '2026-06-05', amountCents: -20_000 }),
      tx({ date: '2026-06-20', amountCents: 220_000, txType: 'income' }),
    ];
    const series = netWorthSeries(accounts, txs, ['2026-05-31', '2026-06-10', '2026-06-30']);
    // before both: 150000 - (−20000 + 220000) = −50000; between: 150000 − 220000
    expect(series.map((p) => p.cents)).toEqual([-50_000, -70_000, 150_000]);
    // archived accounts never count
    expect(netWorthSeries([{ id: 'a1', balanceCents: 1, archived: 1, deleted: 0 }], [], ['2026-06-30'])[0].cents).toBe(0);
  });
});

describe('dailyBalanceSeries (the balance line, user 2026-10-08)', () => {
  const accounts = [
    { id: 'a1', type: 'checking' as const, balanceCents: 100_000, archived: 0 as const, deleted: 0 as const },
    { id: 'sav', type: 'savings' as const, balanceCents: 50_000, archived: 0 as const, deleted: 0 as const },
    { id: 'loan', type: 'loan' as const, balanceCents: -900_000, archived: 0 as const, deleted: 0 as const }, // not liquid
    { id: 'pot', type: 'funding' as const, balanceCents: 7_000, archived: 0 as const, deleted: 0 as const }, // the shared pot
    { id: 'old', type: 'cash' as const, balanceCents: 3_000, archived: 1 as const, deleted: 0 as const },
  ];

  it('one point per day, walked back from today’s liquid balances', () => {
    const txs = [
      tx({ date: '2026-06-02', amountCents: -20_000 }),
      tx({ date: '2026-06-04', amountCents: 220_000, txType: 'income' }),
      tx({ date: '2026-06-04', amountCents: -5_000, accountId: 'loan' }), // not liquid
      tx({ date: '2026-06-09', amountCents: -1_000, pending: 1 }), // reservation noise
      tx({ date: '2026-06-20', amountCents: -30_000 }), // after the window: already "after" every day
    ];
    const daily = dailyBalanceSeries(accounts, txs, '2026-06-01', '2026-06-05');
    expect(daily.map((p) => p.date)).toEqual(['2026-06-01', '2026-06-02', '2026-06-03', '2026-06-04', '2026-06-05']);
    // now 150000; after 06-05: −30000 ⇒ 180000 on the 5th and 4th; the 3rd is
    // before the +220000 credit ⇒ −40000; the 1st is before the −20000 too
    expect(daily.map((p) => p.cents)).toEqual([-20_000, -40_000, -40_000, 180_000, 180_000]);
  });

  it('an empty window yields nothing', () => {
    expect(dailyBalanceSeries(accounts, [], '2026-06-05', '2026-06-01')).toEqual([]);
  });
});

describe('incomeSpikes', () => {
  it('names each day’s largest credit of at least €500, income rows only', () => {
    const txs = [
      tx({ date: '2026-06-25', amountCents: 220_000, txType: 'income', merchant: 'Demo Corp BV' }),
      tx({ date: '2026-06-25', amountCents: 60_000, txType: 'income', merchant: 'Bonus' }),
      tx({ date: '2026-06-10', amountCents: 55_000, txType: 'income', merchant: 'Freelance', titleOverride: 'Side gig' }),
      tx({ date: '2026-06-12', amountCents: 40_000, txType: 'income', merchant: 'small' }),
      tx({ date: '2026-06-13', amountCents: 90_000, txType: 'transfer', merchant: 'From savings' }),
      tx({ date: '2026-07-02', amountCents: 220_000, txType: 'income', merchant: 'next month' }),
    ];
    expect(incomeSpikes(txs, '2026-06-01', '2026-06-30')).toEqual([
      { date: '2026-06-10', merchant: 'Side gig', cents: 55_000 },
      { date: '2026-06-25', merchant: 'Demo Corp BV', cents: 220_000 },
    ]);
    expect(incomeSpikes(txs, '2026-06-01', '2026-06-30', 100_000)).toHaveLength(1);
  });
});

describe('periodBalanceRange + median', () => {
  it('finds each period’s low and high with their dates; a period without days is null', () => {
    const daily = [
      { date: '2026-05-30', cents: 500 },
      { date: '2026-05-31', cents: 100 },
      { date: '2026-06-01', cents: 300 },
      { date: '2026-06-02', cents: 900 },
      { date: '2026-06-03', cents: 200 },
    ];
    const ranges = periodBalanceRange(daily, [...periods, { start: '2026-07-01', end: '2026-07-31' }]);
    expect(ranges[0]).toEqual({ low: 100, high: 500, lowDate: '2026-05-31', highDate: '2026-05-30' });
    expect(ranges[1]).toEqual({ low: 200, high: 900, lowDate: '2026-06-03', highDate: '2026-06-02' });
    expect(ranges[2]).toBeNull();
  });

  it('median: odd picks the middle, even averages the two middles, empty is null', () => {
    expect(median([30, 10, 20])).toBe(20);
    expect(median([10, 40])).toBe(25);
    expect(median([])).toBeNull();
  });
});

describe('balanceProjection (the dashed expected path)', () => {
  it('walks the recurring costs and the payday to the period end, flat afterwards', () => {
    const recurrings = [
      rec({ amountCents: 1_500, dueDay: 20, catId: 'subs' }),
      rec({ amountCents: 1_000, dueDay: 25, catId: 'subs', active: 0 }), // off
      rec({ amountCents: 2_000, dueDay: 10, catId: 'subs' }), // already passed
    ];
    const path = balanceProjection(10_000, '2026-06-15', '2026-06-30', recurrings, { date: '2026-06-24', merchant: 'Demo Corp', amountCents: 50_000 });
    expect(path).toEqual([
      { date: '2026-06-15', cents: 10_000 },
      { date: '2026-06-20', cents: 8_500 },
      { date: '2026-06-24', cents: 58_500 },
      { date: '2026-06-30', cents: 58_500 },
    ]);
  });

  it('an income recurring pays in — and claims its day, so the detected payday is not counted twice', () => {
    const recurrings = [rec({ amountCents: 40_000, dueDay: 24, catId: 'salary' })];
    const path = balanceProjection(10_000, '2026-06-15', '2026-06-30', recurrings, { date: '2026-06-24', merchant: 'Demo Corp', amountCents: 50_000 });
    expect(path.map((p) => p.cents)).toEqual([10_000, 50_000, 50_000]);
  });

  it('a payday outside the period and a period already over add nothing', () => {
    expect(balanceProjection(1, '2026-06-15', '2026-06-30', [], { date: '2026-07-24', merchant: 'x', amountCents: 5 })).toEqual([
      { date: '2026-06-15', cents: 1 },
      { date: '2026-06-30', cents: 1 },
    ]);
    expect(balanceProjection(1, '2026-06-30', '2026-06-30', [rec({})], null)).toEqual([{ date: '2026-06-30', cents: 1 }]);
  });
});

describe('trendLabels (the period axis respects the period dates)', () => {
  const twelve = Array.from({ length: 12 }, (_, i) => {
    const month = String(i + 1).padStart(2, '0');
    return { start: `2026-${month}-01`, end: `2026-${month}-28` };
  });

  it('periods on the 1st read as months — first, middle and last only', () => {
    const labels = trendLabels(twelve, 'month', 1, 'en-GB');
    expect(labels[0]).toBe('Jan');
    expect(labels[6]).toBe('Jul');
    expect(labels[11]).toBe('Dec');
    expect(labels.filter(Boolean)).toHaveLength(3);
  });

  it('a period that starts mid-month is named by its start date; weekly rhythms too', () => {
    const shifted = twelve.map((p) => ({ start: `${p.start.slice(0, 8)}21`, end: p.end }));
    expect(trendLabels(shifted, 'month', 21, 'en-GB')[0]).toBe('21 Jan');
    expect(trendLabels(twelve, 'week', 1, 'en-GB')[11]).toBe('1 Dec');
    expect(periodLabel(twelve[2], 'month', 1, 'en-GB')).toBe('Mar');
    expect(periodLabel(twelve[2], 'biweekly', 1, 'en-GB')).toBe('1 Mar');
  });

  it('localDate parses a yyyy-mm-dd as a local calendar day', () => {
    const d = localDate('2026-03-05');
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 2, 5]);
  });
});
