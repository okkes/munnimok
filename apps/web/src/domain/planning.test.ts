import { describe, expect, it } from 'vitest';
import type { AccountRow, BudgetRow, GoalContributionRow, GoalRow, PlanSubjectRow, RecurringRow, TxView } from '@/db/types';
import {
  aheadColor,
  aheadSuggested,
  brokenSubjects,
  budgetTargetCents,
  categoryReservations,
  coverCandidates,
  debtTargetCents,
  estimateTarget,
  expenseRealizedCents,
  fillInOrder,
  goalTargetCents,
  mirroredSubjectId,
  periodAt,
  periodsAhead,
  periodsUntil,
  planFundedFraction,
  planId,
  planPoolAccounts,
  poolCents,
  recommendSubjects,
  recurringTargetCents,
  unplannedByCategory,
  reservationConflicts,
  sameSubjects,
  spreadTargetCents,
  subjectFamily,
  subjectStatus,
  subjectView,
  canSkipPeriod,
} from './planning';
import type { SubjectContext, SubjectView } from './planning';

const space = { periodType: 'month' as const, periodDay: 1 };
const period = { start: '2026-10-01', end: '2026-10-31' };

const catalog = {
  byId: (id: string | undefined) => ({ id: id ?? '', parentId: id?.startsWith('sub_') ? id.split('_')[1] : undefined }),
  childrenOf: (id: string) => (id === 'food' ? [{ id: 'sub_food_a' }, { id: 'sub_food_b' }] : id === 'fun' ? [{ id: 'sub_fun_a' }] : []),
};

const envelope = { spaceId: 's', hlc: '0', deleted: 0 as const, fieldVersions: {} };

const tx = (over: Partial<TxView>): TxView =>
  ({
    id: 't',
    accountId: 'a',
    date: '2026-10-10',
    amountCents: -1000,
    currency: 'EUR',
    merchant: 'm',
    needsReview: 0,
    txType: 'expense',
    ...envelope,
    ...over,
  }) as TxView;

const subject = (over: Partial<PlanSubjectRow>): PlanSubjectRow =>
  ({ id: 'p1', planId: 'plan', segment: 'expenses', order: 0, name: 'Food', fundedCents: 0, ...envelope, ...over }) as PlanSubjectRow;

const account = (over: Partial<AccountRow>): AccountRow =>
  ({ id: 'acc', name: 'Main', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_00, ...envelope, ...over }) as AccountRow;

describe('periods for planning', () => {
  it('finds the period a date falls in, the periods ahead, and how many periods a date is away', () => {
    expect(periodAt(space, '2026-10-15')).toEqual(period);
    const ahead = periodsAhead(space, 2, new Date(2026, 9, 15));
    expect(ahead.map((p) => p.start)).toEqual(['2026-11-01', '2026-12-01']);
    expect(periodsUntil(space, period, '2026-10-20')).toBe(1);
    expect(periodsUntil(space, period, '2027-01-05')).toBe(4);
    expect(periodsUntil({ periodType: 'week', periodDay: 1 }, { start: '2026-09-28', end: '2026-10-04' }, '2026-10-20')).toBe(4);
  });

  it('suggests three months of resilience in the space’s own cadence', () => {
    expect(aheadSuggested('week')).toBe(12);
    expect(aheadSuggested('biweekly')).toBe(6);
    expect(aheadSuggested('month')).toBe(3);
    expect(aheadSuggested('custom')).toBe(1);
  });

  it('deterministic ids: one actual plan and one sandbox per period, one subject per mirrored source', () => {
    expect(planId('s', 'actual', '2026-10-01')).toBe('plan:s:actual:2026-10-01');
    expect(mirroredSubjectId('plan:s:actual:2026-10-01', 'budgets', 'b1')).toBe('psub:plan:s:actual:2026-10-01:budgets:b1');
  });
});

describe('the pool', () => {
  it('is every checking and cash account unless the space picked a list; savings, pots and archived accounts stay out', () => {
    const accounts = [
      account({ id: 'c', type: 'checking', balanceCents: 500_00 }),
      account({ id: 'cash', type: 'cash', balanceCents: 20_00 }),
      account({ id: 'sav', type: 'savings', balanceCents: 1000_00 }),
      account({ id: 'pot', type: 'checking', defaultFor: 'transfer', balanceCents: 5_00 }),
      account({ id: 'old', type: 'checking', archived: 1, balanceCents: 99_00 }),
    ];
    expect(planPoolAccounts(accounts, null).map((a) => a.id)).toEqual(['c', 'cash']);
    expect(poolCents(accounts, null)).toBe(520_00);
    expect(poolCents(accounts, { planPoolAccountIds: ['sav', 'pot'] })).toBe(1005_00);
  });
});

describe('families and reservations', () => {
  it('a main claims its subs minus the excluded ones; a sub claims itself', () => {
    expect([...subjectFamily({ catIds: ['food'], excludeCatIds: ['sub_food_b'] }, catalog)]).toEqual(['food', 'sub_food_a']);
    expect([...subjectFamily({ catIds: ['sub_fun_a'] }, catalog)]).toEqual(['sub_fun_a']);
  });

  it('expense and budget subjects reserve their categories; a conflict names the holder', () => {
    const subjects = [
      subject({ id: 'e1', name: 'Groceries', catIds: ['sub_food_a'] }),
      subject({ id: 'b1', segment: 'budgets', name: 'Fun', sourceId: 'bud' }),
      subject({ id: 'r1', segment: 'recurring', name: 'Netflix', sourceId: 'rec', catIds: ['fun'] }),
    ];
    const budgets = new Map([['bud', { name: 'Fun budget', catIds: ['fun'] }]]);
    const reservations = categoryReservations(subjects, budgets, catalog);
    expect(reservations.get('sub_food_a')?.name).toBe('Groceries');
    expect(reservations.get('sub_fun_a')?.segment).toBe('budgets');
    expect(reservations.has('food')).toBe(false);
    const conflicts = reservationConflicts(subjectFamily({ catIds: ['food'] }, catalog), reservations);
    expect([...conflicts.keys()]).toEqual(['sub_food_a']);
    expect(reservationConflicts(subjectFamily({ catIds: ['food'] }, catalog), reservations, 'e1').size).toBe(0);
  });
});

describe('realization', () => {
  it('an expense subject counts its family’s spending and leaves recurring-linked and account-linked rows to their own segments', () => {
    const family = new Set(['sub_food_a']);
    const txs = [
      tx({ id: '1', catId: 'sub_food_a', amountCents: -1200 }),
      tx({ id: '2', catId: 'sub_food_a', amountCents: -800, recurringId: 'rec' }),
      tx({ id: '3', catId: 'sub_food_a', amountCents: -500, linkedAccountId: 'loan', txType: 'debtPayment' }),
      tx({ id: '4', catId: 'sub_food_b', amountCents: -300 }),
      tx({ id: '5', catId: 'sub_food_a', amountCents: -300, date: '2026-09-30' }),
      tx({ id: '6', catId: 'sub_food_a', amountCents: 200 }),
    ];
    expect(expenseRealizedCents(family, txs, period)).toBe(1000);
  });
});

describe('targets', () => {
  const budget = (every: BudgetRow['every'], amountCents: number): BudgetRow =>
    ({ id: 'b', name: 'B', amountCents, every, anchor: '2026-01-05', catIds: ['fun'], active: 1, ...envelope }) as BudgetRow;

  it('scales a budget to the plan’s period: a weekly budget on a monthly plan is the weeks that start inside it; a monthly budget on a weekly plan a week’s share', () => {
    const weekly = budgetTargetCents(budget('week', 50_00), period);
    expect(weekly.cycles).toBeGreaterThanOrEqual(4);
    expect(weekly.cycles).toBeLessThanOrEqual(5);
    expect(weekly.cents).toBe(50_00 * weekly.cycles);
    const monthly = budgetTargetCents(budget('month', 300_00), { start: '2026-10-05', end: '2026-10-11' });
    expect(monthly.cycles).toBe(1);
    expect(monthly.cents).toBe(Math.round((300_00 * 7) / 30.44));
    expect(budgetTargetCents(budget('period', 120_00), period)).toEqual({ cents: 120_00, cycles: 1 });
  });

  it('spreads an amount due later over the periods left, what was set aside taken off', () => {
    expect(spreadTargetCents(1200_00, 0, 4)).toBe(300_00);
    expect(spreadTargetCents(1200_00, 900_00, 1)).toBe(300_00);
    expect(spreadTargetCents(1200_00, 1500_00, 2)).toBe(0);
  });

  it('a yearly bill five periods out wants a fifth now; a monthly one all of it; a loan payment follows its due day', () => {
    const insurance = { active: 1 as const, amountCents: 1200_00, every: 'year' as const, dueDay: 15, dueMonth: 2 };
    expect(recurringTargetCents(insurance, space, period, 0)).toBe(240_00);
    const rent = { active: 1 as const, amountCents: 900_00, every: 'month' as const, dueDay: 25 };
    expect(recurringTargetCents(rent, space, period, 0)).toBe(900_00);
    expect(debtTargetCents({ paymentCents: 250_00, paymentEvery: 'month', paymentDay: 10 }, space, period, 0)).toBe(250_00);
    expect(debtTargetCents({ paymentCents: 0 }, space, period, 0)).toBe(0);
    // a weekly cost falls due four Mondays in October: every one of them is the target (user ss 2026-10-02)
    const weekly = { active: 1 as const, amountCents: 15_00, every: 'week' as const, dueDay: 1, since: '2026-09-07' };
    expect(recurringTargetCents(weekly, space, period, 0)).toBe(60_00);
    expect(recurringTargetCents(weekly, space, period, 20_00)).toBe(40_00);
  });

  it('spending outside every subject gathers under its main, subs broken out, locked families left alone', () => {
    const catalog = {
      byId: (id: string | undefined) => ({ id: id ?? 'uncategorized', parentId: id === 'groceries' || id === 'coffee' ? 'consumption' : id === 'movie' ? 'entertainment' : undefined }),
      childrenOf: () => [],
    };
    const txs = [
      tx({ id: 'u1', date: '2026-10-03', amountCents: -40_00, catId: 'groceries' }),
      tx({ id: 'u2', date: '2026-10-04', amountCents: -10_00, catId: 'coffee' }),
      tx({ id: 'u3', date: '2026-10-05', amountCents: -25_00, catId: 'movie' }),
      tx({ id: 'u4', date: '2026-10-06', amountCents: -99_00, catId: 'groceries', recurringId: 'rec1' }),
      tx({ id: 'u5', date: '2026-09-30', amountCents: -5_00, catId: 'coffee' }),
    ];
    const rows = unplannedByCategory(txs, period, new Set(['movie']), catalog);
    expect(rows.map((r) => [r.mainId, r.cents])).toEqual([['consumption', 50_00]]);
    expect(rows[0].subs).toEqual([{ catId: 'groceries', cents: 40_00 }, { catId: 'coffee', cents: 10_00 }]);
  });

  it('a goal spreads what is left over the periods before its date; an undated goal has no target', () => {
    expect(goalTargetCents({ targetCents: 1200_00, allocatedCents: 300_00, targetDate: '2027-01-15' }, space, period)).toBe(225_00);
    expect(goalTargetCents({ targetCents: 100_00, allocatedCents: 100_00, targetDate: '2027-01-15' }, space, period)).toBe(0);
    expect(goalTargetCents({ targetCents: 100_00, allocatedCents: 0 }, space, period)).toBeNull();
  });
});

describe('status', () => {
  it('red when more left than funded, orange under a target, green at it, budgets green from nought, snoozed green by decree', () => {
    expect(subjectStatus('expenses', 100_00, 40_00, 10_00, false)).toBe('underfunded');
    expect(subjectStatus('expenses', 100_00, 100_00, 10_00, false)).toBe('funded');
    expect(subjectStatus('expenses', 100_00, 40_00, 50_00, false)).toBe('overspent');
    expect(subjectStatus('expenses', 0, 0, 0, false)).toBe('neutral');
    expect(subjectStatus('expenses', 0, 10_00, 0, false)).toBe('funded');
    expect(subjectStatus('budgets', 100_00, 0, 0, false)).toBe('funded');
    expect(subjectStatus('budgets', 100_00, 20_00, 150_00, false)).toBe('overspent');
    expect(subjectStatus('recurring', 100_00, 0, 0, true)).toBe('snoozed');
  });
});

describe('the subject view', () => {
  const ctx = (over: Partial<SubjectContext> = {}): SubjectContext => ({
    space,
    period,
    txs: [],
    catalog,
    budgetsById: new Map(),
    recurringsById: new Map(),
    loansById: new Map(),
    goalsById: new Map(),
    contributions: [],
    carriedBySource: new Map(),
    budgetOpts: {},
    ...over,
  });

  it('an expense subject: its target, its spending, its colour', () => {
    const view = subjectView(subject({ catIds: ['sub_food_a'], targetCents: 50_00, fundedCents: 30_00 }), ctx({ txs: [tx({ catId: 'sub_food_a', amountCents: -20_00 })] }));
    expect(view).toMatchObject({ targetCents: 50_00, fundedCents: 30_00, realizedCents: 20_00, status: 'underfunded', orphaned: false });
  });

  it('dueThisPeriod: a yearly cost spread over months and a goal far off may be skipped; a monthly cost and a goal due now may not', () => {
    const yearly = { id: 'ins', name: 'Insurance', kind: 'fixed', amountCents: 1200_00, every: 'year', dueDay: 15, dueMonth: 2, active: 1, ...envelope } as RecurringRow;
    const monthly = { id: 'rent', name: 'Rent', kind: 'fixed', amountCents: 900_00, every: 'month', dueDay: 25, active: 1, ...envelope } as RecurringRow;
    const recurrings = new Map([['ins', yearly], ['rent', monthly]]);
    const skippable = subjectView(subject({ segment: 'recurring', sourceId: 'ins' }), ctx({ recurringsById: recurrings }));
    const due = subjectView(subject({ segment: 'recurring', sourceId: 'rent' }), ctx({ recurringsById: recurrings }));
    expect(skippable.dueThisPeriod).toBe(false);
    expect(canSkipPeriod(skippable)).toBe(true);
    expect(due.dueThisPeriod).toBe(true);
    expect(canSkipPeriod(due)).toBe(false);
    const far = { id: 'g1', name: 'Car', targetCents: 1000_00, allocatedCents: 0, targetDate: '2027-12-31', ...envelope } as GoalRow;
    const soon = { id: 'g2', name: 'Trip', targetCents: 100_00, allocatedCents: 0, targetDate: '2026-10-20', ...envelope } as GoalRow;
    const goals = new Map([['g1', far], ['g2', soon]]);
    expect(canSkipPeriod(subjectView(subject({ segment: 'goals', sourceId: 'g1' }), ctx({ goalsById: goals })))).toBe(true);
    expect(canSkipPeriod(subjectView(subject({ segment: 'goals', sourceId: 'g2' }), ctx({ goalsById: goals })))).toBe(false);
    // an expense is never skipped: its money leaves whenever it is spent
    expect(canSkipPeriod(subjectView(subject({ catIds: ['sub_food_a'], targetCents: 50_00 }), ctx()))).toBe(false);
  });

  it('a recurring subject carries what earlier periods set aside; a goal counts its contributions; a vanished source is orphaned', () => {
    const rec = { id: 'rec', name: 'Insurance', kind: 'fixed', amountCents: 1200_00, every: 'year', dueDay: 15, dueMonth: 2, active: 1, ...envelope } as RecurringRow;
    const recurring = subjectView(subject({ segment: 'recurring', sourceId: 'rec', fundedCents: 0 }), ctx({ recurringsById: new Map([['rec', rec]]), carriedBySource: new Map([['rec', 600_00]]) }));
    // February is five periods away from October, so (1200 − 600) / 5
    expect(recurring.targetCents).toBe(120_00);
    expect(recurring.carriedCents).toBe(600_00);
    const goal = { id: 'g', name: 'Car', targetCents: 1000_00, allocatedCents: 0, targetDate: '2026-12-31', ...envelope } as GoalRow;
    const contributions = [{ id: 'c1', goalId: 'g', amountCents: 100_00, date: '2026-10-05', ...envelope }] as GoalContributionRow[];
    const goalView = subjectView(subject({ segment: 'goals', sourceId: 'g', fundedCents: 100_00 }), ctx({ goalsById: new Map([['g', goal]]), contributions }));
    expect(goalView.realizedCents).toBe(100_00);
    expect(goalView.targetCents).toBe(Math.ceil(1000_00 / 3));
    expect(subjectView(subject({ segment: 'budgets', sourceId: 'gone' }), ctx()).orphaned).toBe(true);
  });
});

describe('ahead, cover, fill', () => {
  const view = (over: Partial<SubjectView> & { id: string; segment?: PlanSubjectRow['segment'] }): SubjectView => ({
    subject: subject({ id: over.id, segment: over.segment ?? 'expenses', name: over.id }),
    targetCents: 100_00,
    fundedCents: 0,
    realizedCents: 0,
    carriedCents: 0,
    cycles: 1,
    status: 'neutral',
    orphaned: false,
    dueThisPeriod: true,
    ...over,
  });

  it('a plan counts as funded by its mandatory targets, budgets left out; the circle colours by the count', () => {
    const views = [
      view({ id: 'a', targetCents: 100_00, fundedCents: 100_00 }),
      view({ id: 'b', targetCents: 100_00, fundedCents: 50_00 }),
      view({ id: 'c', segment: 'budgets', targetCents: 500_00, fundedCents: 0 }),
    ];
    expect(planFundedFraction(views)).toBe(0.75);
    expect(planFundedFraction([])).toBe(0);
    expect(aheadColor(0)).toBe('grey');
    expect(aheadColor(1.5)).toBe('green');
    expect(aheadColor(2)).toBe('orange');
    expect(aheadColor(4)).toBe('red');
  });

  it('cover: the picks are the subjects past their target and the budgets; everybody with slack is in the full list', () => {
    const views = [
      view({ id: 'need', fundedCents: 10_00, realizedCents: 40_00 }),
      view({ id: 'over', targetCents: 50_00, fundedCents: 80_00, realizedCents: 10_00 }),
      view({ id: 'bud', segment: 'budgets', targetCents: 100_00, fundedCents: 30_00, realizedCents: 0 }),
      view({ id: 'tight', targetCents: 100_00, fundedCents: 100_00, realizedCents: 90_00 }),
      view({ id: 'empty', fundedCents: 0 }),
    ];
    const { picks, all } = coverCandidates(views, 'need');
    expect(picks.map((v) => v.subject.id)).toEqual(['over', 'bud']);
    expect(all.map((v) => v.subject.id)).toEqual(['over', 'bud', 'tight']);
  });

  it('fill in order gives each subject its shortfall until the money runs out; a snoozed one is skipped', () => {
    const views = [
      view({ id: 'a', targetCents: 60_00, fundedCents: 10_00 }),
      view({ id: 'z', targetCents: 100_00, fundedCents: 0, subject: subject({ id: 'z', snoozed: 1 }) }),
      view({ id: 'b', targetCents: 100_00, fundedCents: 0 }),
    ];
    expect([...fillInOrder(views, 80_00)]).toEqual([
      ['a', 50_00],
      ['b', 30_00],
    ]);
  });
});

describe('estimates, blueprints, the recommendation', () => {
  it('estimates a family’s target from the previous period and the average', () => {
    const past = [
      { start: '2026-08-01', end: '2026-08-31' },
      { start: '2026-09-01', end: '2026-09-30' },
    ];
    const txs = [tx({ id: '1', catId: 'sub_food_a', amountCents: -100_00, date: '2026-08-10' }), tx({ id: '2', catId: 'sub_food_a', amountCents: -200_00, date: '2026-09-10' })];
    expect(estimateTarget(new Set(['sub_food_a']), txs, past)).toEqual({ lastCents: 200_00, averageCents: 150_00 });
    expect(estimateTarget(new Set(['sub_food_a']), txs, [])).toEqual({ lastCents: null, averageCents: null });
  });

  it('two plans are the same shape whatever their ids and order; a broken one names what is gone', () => {
    const a = [subject({ id: '1', catIds: ['food'], targetCents: 10 }), subject({ id: '2', segment: 'budgets', sourceId: 'b', order: 5 })];
    const b = [subject({ id: '9', segment: 'budgets', sourceId: 'b', order: 0 }), subject({ id: '8', catIds: ['food'], targetCents: 10, fundedCents: 99 })];
    expect(sameSubjects(a, b)).toBe(true);
    expect(sameSubjects(a, [a[0]])).toBe(false);
    const broken = brokenSubjects([...a, subject({ id: '3', catIds: ['vanished'] })], {
      catalog: { ...catalog, all: [{ id: 'food' }, { id: 'sub_food_a' }] },
      budgetIds: new Set(),
      recurringIds: new Set(),
      loanIds: new Set(),
      goalIds: new Set(),
    });
    expect(broken.map((s) => s.id)).toEqual(['2', '3']);
  });

  it('recommends an expense subject per main the person spent on (a budget takes its place), every recurring cost and loan, and goals only when the income leaves room', () => {
    const past = [{ start: '2026-09-01', end: '2026-09-30' }];
    const input = {
      catalog: { ...catalog, parents: [{ id: 'food' }, { id: 'fun' }, { id: 'quiet' }] },
      nameOf: (id: string) => id.toUpperCase(),
      txs: [tx({ id: '1', catId: 'sub_food_a', amountCents: -300_00, date: '2026-09-10' }), tx({ id: '2', catId: 'sub_fun_a', amountCents: -50_00, date: '2026-09-12' })],
      pastPeriods: past,
      budgets: [{ id: 'bud', name: 'Fun', amountCents: 80_00, every: 'period', anchor: '2026-01-01', catIds: ['fun'], active: 1, ...envelope } as BudgetRow],
      recurrings: [{ id: 'rec', name: 'Rent', kind: 'fixed', amountCents: 900_00, every: 'month', dueDay: 1, active: 1, ...envelope } as RecurringRow],
      accounts: [account({ id: 'loan', type: 'loan', paymentCents: 100_00, paymentEvery: 'month', paymentDay: 5, balanceCents: -5000_00 })],
      goals: [{ id: 'g', name: 'Car', targetCents: 1000_00, allocatedCents: 0, ...envelope } as GoalRow],
      space,
      period,
    };
    const rich = recommendSubjects({ ...input, incomeCents: 5000_00 });
    expect(rich.map((s) => `${s.segment}:${s.name}`)).toEqual(['recurring:Rent', 'debts:Main', 'expenses:FOOD', 'budgets:Fun', 'goals:Car']);
    expect(rich.find((s) => s.segment === 'expenses')?.targetCents).toBe(300_00);
    const tight = recommendSubjects({ ...input, incomeCents: 1000_00 });
    expect(tight.some((s) => s.segment === 'goals')).toBe(false);
    expect(recommendSubjects({ ...input, incomeCents: null }).some((s) => s.segment === 'goals')).toBe(false);
  });
});
