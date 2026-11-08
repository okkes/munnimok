import { describe, expect, it } from 'vitest';
import {
  budgetRealityCheck,
  collectInsights,
  debtAcceleration,
  debtClear,
  extraFor,
  groupInsights,
  priceCreep,
  smallHabit,
  subscriptionOverlap,
} from './insights';
import type { Insight, InsightInputs } from './insights';
import { simulateDebtAlone, toPlanDebts } from './debtPlan';
import type { AccountRow, BudgetRow, RecurringRow, TxView } from '@/db/types';

const tx = (partial: Partial<TxView>): TxView =>
  ({
    id: Math.random().toString(36).slice(2),
    spaceId: 's1',
    accountId: 'a1',
    date: '2026-07-05',
    amountCents: -1000,
    currency: 'EUR',
    merchant: 'Shop',
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    ...partial,
  }) as TxView;

const rec = (partial: Partial<RecurringRow>): RecurringRow =>
  ({ id: 'r1', spaceId: 's1', name: 'Netflix', kind: 'subscription', amountCents: 1399, every: 'month', dueDay: 1, active: 1, deleted: 0, ...partial }) as RecurringRow;

const catalog = {
  byId: (id: string | undefined) => ({ id: id ?? 'uncategorized', parentId: id === 'streaming' ? 'entertainment' : undefined }),
  childrenOf: () => [] as { id: string }[],
};

const base = (partial: Partial<InsightInputs>): InsightInputs => ({
  txs: [],
  recurrings: [],
  budgets: [],
  loans: [],
  accountsById: new Map(),
  catalog,
  periods: [
    { start: '2026-06-01', end: '2026-06-30' },
    { start: '2026-07-01', end: '2026-07-31' },
  ],
  today: '2026-07-10',
  currency: 'EUR',
  ...partial,
});

const loanOf = (partial: Partial<AccountRow>): AccountRow =>
  ({
    id: 'd1',
    spaceId: 's1',
    name: 'Student loan',
    type: 'loan',
    source: 'manual',
    currency: 'EUR',
    balanceCents: -2_500_000,
    originalCents: 2_500_000,
    interestPctYear: 8,
    paymentCents: 30_000,
    deleted: 0,
    ...partial,
  }) as AccountRow;

describe('insight detectors', () => {
  it('price creep fires on a SUSTAINED increase, stays silent under €0.50/mo or one-offs', () => {
    const charges = [
      tx({ recurringId: 'r1', amountCents: -1399, date: '2026-03-01' }),
      tx({ recurringId: 'r1', amountCents: -1399, date: '2026-04-01' }),
      tx({ recurringId: 'r1', amountCents: -1599, date: '2026-06-01' }),
      tx({ recurringId: 'r1', amountCents: -1599, date: '2026-07-01' }),
    ];
    const hits = priceCreep(base({ recurrings: [rec({})], txs: charges }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'creep:r1:1599', severity: 'leak', impactCents: 2400 });

    // a single pricier charge (proration) is not a price change yet
    expect(priceCreep(base({ recurrings: [rec({})], txs: charges.slice(0, 3) }))).toHaveLength(0);

    const tiny = charges.map((c) => ({ ...c, amountCents: c.amountCents === -1599 ? -1420 : c.amountCents }));
    expect(priceCreep(base({ recurrings: [rec({})], txs: tiny }))).toHaveLength(0);
  });

  it('funding-filed recurrings get no leak advice — moved money, not spent (#356)', () => {
    const charges = [
      tx({ recurringId: 'r1', amountCents: -1399, date: '2026-03-01' }),
      tx({ recurringId: 'r1', amountCents: -1399, date: '2026-04-01' }),
      tx({ recurringId: 'r1', amountCents: -1599, date: '2026-06-01' }),
      tx({ recurringId: 'r1', amountCents: -1599, date: '2026-07-01' }),
    ];
    expect(priceCreep(base({ recurrings: [rec({ catId: 'fundingOut' })], txs: charges }))).toHaveLength(0);
    const pots = [
      rec({ id: 'r1', name: 'Family pot', catId: 'fundingOut' }),
      rec({ id: 'r2', name: 'Shared pot', catId: 'fundingOut', amountCents: 999 }),
    ];
    expect(subscriptionOverlap(base({ recurrings: pots }))).toHaveLength(0);
  });

  it('subscription overlap reads the category as filed — two streaming services overlap, internet and energy do not', () => {
    const subs = [
      rec({ id: 'r1', name: 'Netflix', catId: 'streaming' }),
      rec({ id: 'r2', name: 'Disney+', catId: 'streaming', amountCents: 999 }),
      rec({ id: 'r3', name: 'Gym', catId: 'sport' }),
      // the same main (Housing), different jobs
      rec({ id: 'r4', name: 'Ziggo', catId: 'telecom', amountCents: 5_500 }),
      rec({ id: 'r5', name: 'Vattenfall', catId: 'housingUtility', amountCents: 12_000 }),
      // nothing filed yet: says nothing about overlap
      rec({ id: 'r6', name: 'Unknown A', catId: undefined }),
      rec({ id: 'r7', name: 'Unknown B', catId: undefined }),
    ];
    const hits = subscriptionOverlap(base({ recurrings: subs }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'overlap', topic: 'subscriptions', about: { cat: 'streaming' } });
    expect(hits[0].params.names).toBe('Netflix + Disney+');
    expect(hits[0].params.month).toEqual({ money: 1399 + 999 });
    expect(hits[0].impactCents).toBe((1399 + 999) * 12);
  });

  it('small habit needs 8 hits and €20 in the current period', () => {
    const coffees = Array.from({ length: 9 }, (_, i) =>
      tx({ merchant: 'Koffiebar', amountCents: -350, date: `2026-07-0${(i % 9) + 1}` }),
    );
    const hits = smallHabit(base({ txs: coffees }));
    expect(hits).toHaveLength(1);
    expect(hits[0].params.n).toBe(9);
    expect(hits[0].params.period).toEqual({ money: 9 * 350 });

    expect(smallHabit(base({ txs: coffees.slice(0, 5) }))).toHaveLength(0);
    // a coffee abroad in another currency never adds to the euros
    expect(smallHabit(base({ txs: coffees.map((c) => ({ ...c, currency: 'USD' })) }))).toHaveLength(0);
    // a weekly space counts a period 52 times a year
    const weekly = smallHabit(base({ txs: coffees, space: { periodType: 'week', periodDay: 1 } }));
    expect(weekly[0].impactCents).toBe(9 * 350 * 52);
  });

  it('budget reality check wants three straight overshoots', () => {
    const budget: BudgetRow = {
      id: 'b1',
      spaceId: 's1',
      name: 'Food',
      catIds: ['consumption'],
      amountCents: 10_000,
      every: 'month',
      anchor: '2026-01-01',
      deleted: 0,
    } as BudgetRow;
    const overshoots = ['2026-04-05', '2026-05-05', '2026-06-05'].map((date) =>
      tx({ catId: 'consumption', amountCents: -15_000, date }),
    );
    const hits = budgetRealityCheck(base({ budgets: [budget], txs: overshoots }));
    expect(hits).toHaveLength(1);
    expect(hits[0].params.suggested).toEqual({ money: 15_000 });
    expect(hits[0].impactCents).toBe(5_000 * 12);

    // one good month breaks the streak
    const mixed = overshoots.slice(0, 2).concat(tx({ catId: 'consumption', amountCents: -5_000, date: '2026-06-05' }));
    expect(budgetRealityCheck(base({ budgets: [budget], txs: mixed }))).toHaveLength(0);
  });

  it('debt acceleration: a round extra in proportion to the payment, walked by the payoff planner', () => {
    // v2: the loan IS a liability account — remaining is its balance
    const loan = loanOf({});
    const hits = debtAcceleration(base({ loans: [loan] }));
    expect(hits).toHaveLength(1);
    // €300 a month: a fifth is €60 — the round step under it is €50
    expect(hits[0]).toMatchObject({ kind: 'debtacc', topic: 'debt', severity: 'win', actionTo: '/debts/plan' });
    expect(hits[0].params.extra).toEqual({ money: 5_000, currency: 'EUR' });
    // the same walk the planner draws: the debt alone, with and without the extra
    const [debt] = toPlanDebts([{ account: loan, remainingCents: 2_500_000 }]);
    const without = simulateDebtAlone(debt, 0);
    const withExtra = simulateDebtAlone(debt, 5_000);
    expect(hits[0].params.months).toBe(without.months! - withExtra.months!);
    expect(hits[0].impactCents).toBe(without.interestCents - withExtra.interestCents);

    expect(debtAcceleration(base({ loans: [loanOf({ paymentCents: undefined })] }))).toHaveLength(0);
    // a rate of 0% or an unknown one saves no interest
    expect(debtAcceleration(base({ loans: [loanOf({ interestPctYear: 0 })] }))).toHaveLength(0);
    expect(debtAcceleration(base({ loans: [loanOf({ interestPctYear: undefined })] }))).toHaveLength(0);
    // the planner counts a weekly payment per month: €70 a week is about €303 a month
    expect(debtAcceleration(base({ loans: [loanOf({ paymentEvery: 'week', paymentCents: 7_000 })] }))).toHaveLength(1);
  });

  it('debt acceleration speaks for the debt where the extra saves the most interest', () => {
    const cheap = loanOf({ id: 'cheap', name: 'Mortgage', interestPctYear: 2, balanceCents: -2_000_000 });
    const dear = loanOf({ id: 'dear', name: 'Credit card', type: 'credit', interestPctYear: 18, balanceCents: -800_000, paymentCents: 20_000 });
    const hits = debtAcceleration(base({ loans: [cheap, dear] }));
    expect(hits.map((h) => h.params.name)).toEqual(['Credit card']);
  });

  it('extraFor: a fifth of the payment as a round step, €25 at least', () => {
    expect(extraFor(9_500)).toBe(2_500);
    expect(extraFor(30_000)).toBe(5_000);
    expect(extraFor(150_000)).toBe(25_000);
  });

  it('a small debt among bigger ones could go quickly — the amount, the months it still takes, what it frees', () => {
    const big = loanOf({ id: 'big', name: 'DUO' });
    const small = loanOf({ id: 'small', name: 'Klarna', balanceCents: -34_000, interestPctYear: 0, paymentCents: 5_000 });
    const hits = debtClear(base({ loans: [big, small] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ id: 'debtclear:small', kind: 'debtclear', severity: 'win', detailKey: 'ins.debtclear.detail' });
    expect(hits[0].params).toMatchObject({ name: 'Klarna', amount: { money: 34_000, currency: 'EUR' }, months: 7, freed: { money: 5_000, currency: 'EUR' } });

    // one debt is no "smaller one"
    expect(debtClear(base({ loans: [small] }))).toHaveLength(0);
    // the next payment ends it anyway — no nudge
    expect(debtClear(base({ loans: [big, { ...small, balanceCents: -4_000 }] }))).toHaveLength(0);
    // not small: €5,000 is ten payments
    expect(debtClear(base({ loans: [big, { ...small, balanceCents: -500_000 }] }))).toHaveLength(0);
    // no payment known: the amount alone
    const plain = debtClear(base({ loans: [big, { ...small, paymentCents: undefined }] }));
    expect(plain[0].detailKey).toBe('ins.debtclear.detailPlain');
    expect(plain[0].params.months).toBeUndefined();
  });
});

const finding = (partial: Partial<Insight>): Insight => ({
  id: 'x',
  kind: 'overlap',
  topic: 'subscriptions',
  severity: 'leak',
  impactCents: 1_000,
  icon: 'content-copy',
  titleKey: 'ins.overlap.title',
  detailKey: 'ins.overlap.detail',
  params: {},
  ...partial,
});

describe('the engine', () => {
  it('ranks alerts first, then leaks, patterns and wins — by impact inside a tier, by id on a tie', () => {
    const subs = [rec({ id: 'r1', catId: 'streaming' }), rec({ id: 'r2', name: 'HBO', catId: 'streaming' })];
    const ranked = collectInsights(base({ loans: [loanOf({})], recurrings: subs }));
    expect(ranked.map((i) => i.severity)).toEqual(['leak', 'win']);

    const order = groupInsights([
      finding({ id: 'w', kind: 'nospend', severity: 'win', impactCents: 99_999 }),
      finding({ id: 'p', kind: 'pace', severity: 'pattern', impactCents: 5 }),
      finding({ id: 'a', kind: 'missed', severity: 'alert', impactCents: 1 }),
      finding({ id: 'l2', kind: 'habit', severity: 'leak', impactCents: 500 }),
      finding({ id: 'l1', kind: 'creep', severity: 'leak', impactCents: 500 }),
    ]);
    expect(order.map((g) => g.id)).toEqual(['a', 'l1', 'l2', 'p', 'w']);
  });

  it('#516: findings that give the same advice share one card; a lone finding keeps its own id', () => {
    const groups = groupInsights([
      finding({ id: 'overlap:subs:2', impactCents: 26_760 }),
      finding({ id: 'overlap:gym:4', impactCents: 8_142 }),
      finding({ id: 'overlap:telecom:5', impactCents: 6_235 }),
      finding({ id: 'debtacc:d1:1', kind: 'debtacc', severity: 'win', impactCents: 258_182 }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ id: 'group:overlap', kind: 'overlap', impactCents: 26_760 + 8_142 + 6_235 });
    expect(groups[0].members.map((m) => m.id)).toEqual(['overlap:subs:2', 'overlap:gym:4', 'overlap:telecom:5']);
    expect(groups[1]).toMatchObject({ id: 'debtacc:d1:1', kind: 'debtacc' });
  });

  it('caps the cards of praise', () => {
    const wins = groupInsights(
      [
        finding({ id: 'w1', kind: 'nospend', severity: 'win', impactCents: 3 }),
        finding({ id: 'w2', kind: 'debtacc', severity: 'win', impactCents: 2 }),
        finding({ id: 'w3', kind: 'debtclear', severity: 'win', impactCents: 1 }),
        finding({ id: 'l', severity: 'leak' }),
      ],
      2,
    );
    expect(wins.map((g) => g.id)).toEqual(['l', 'w1', 'w2']);
  });
});
