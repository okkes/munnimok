import { describe, expect, it } from 'vitest';
import type { AccountRow, BudgetRow, EventRow, GoalContributionRow, GoalRow, PlanSubjectRow, RecurringRow, TxView } from '@/db/types';
import {
  aheadColor,
  aheadSuggested,
  brokenSubjects,
  budgetTargetCents,
  categoryReservations,
  coverCandidates,
  debtTargetCents,
  estimateTarget,
  eventInPeriod,
  eventNetBefore,
  eventTargetCents,
  familySpentCents,
  fillInOrder,
  goalTargetCents,
  isEventPast,
  mirroredSubjectId,
  overlapsOf,
  periodAt,
  periodLedger,
  periodsAhead,
  periodsUntil,
  planFundedFraction,
  planId,
  planPoolAccounts,
  poolCents,
  recommendSubjects,
  recurringTargetCents,
  sliceOwner,
  stillRelevant,
  unplannedByCategory,
  unplannedKey,
  unplannedRows,
  unplannedSources,
  reservationConflicts,
  sameSubjects,
  spreadTargetCents,
  subjectFamily,
  subjectStatus,
  subjectView,
  canSkipPeriod,
} from './planning';
import type { PeriodLedger, SliceOwners, SubjectContext, SubjectView } from './planning';
import type { TxSliceView } from './txSlices';

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

/** no source owns anything: every expense slice is category spending */
const NO_OWNERS: SliceOwners = { recurringIds: new Set(), loanIds: new Set(), eventIds: new Set(), poolIds: new Set() };
const ledgerOf = (txs: TxView[], over: Partial<SliceOwners> = {}, forPeriod = period): PeriodLedger => periodLedger(txs, forPeriod, { ...NO_OWNERS, ...over });

const event = (over: Partial<EventRow>): EventRow => ({ id: 'ev', name: 'Trip', ...envelope, ...over }) as EventRow;

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
  it('is every checking and cash account unless the space picked a list; savings and archived accounts stay out', () => {
    const accounts = [
      account({ id: 'c', type: 'checking', balanceCents: 500_00 }),
      account({ id: 'cash', type: 'cash', balanceCents: 20_00 }),
      // the space's cash wallet is the person's own cash (#348) — it counts like any cash account
      account({ id: 'wallet', type: 'cash', defaultFor: 'cash', balanceCents: 5_00 }),
      account({ id: 'sav', type: 'savings', balanceCents: 1000_00 }),
      account({ id: 'old', type: 'checking', archived: 1, balanceCents: 99_00 }),
    ];
    expect(planPoolAccounts(accounts, null).map((a) => a.id)).toEqual(['c', 'cash', 'wallet']);
    expect(poolCents(accounts, null)).toBe(525_00);
    // a picked list stands as picked — the wallet stays out of it unless ticked
    expect(poolCents(accounts, { planPoolAccountIds: ['sav', 'c'] })).toBe(1500_00);
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

  it('first come keeps its place (#535): of two subjects claiming a category the one that came into the plan first holds it, whatever the segment', () => {
    const born = (stamp: string) => ({ fieldVersions: { planId: stamp } });
    const budgets = new Map([['bud', { name: 'Food budget', catIds: ['food'] }]]);
    // the expense subject came first: the budget added later is blocked on the overlap
    const expenseFirst = [
      subject({ id: 'b1', segment: 'budgets', name: 'Food', sourceId: 'bud', ...born('0002') }),
      subject({ id: 'e1', name: 'Consumption', catIds: ['food'], ...born('0001') }),
    ];
    const held = categoryReservations(expenseFirst, budgets, catalog);
    expect(held.get('sub_food_a')?.subjectId).toBe('e1');
    const blocked = overlapsOf('b1', subjectFamily({ catIds: ['food'] }, catalog), held);
    expect(blocked).toEqual([{ holder: expect.objectContaining({ subjectId: 'e1', name: 'Consumption', segment: 'expenses' }), catIds: ['food', 'sub_food_a', 'sub_food_b'] }]);
    expect(overlapsOf('e1', subjectFamily({ catIds: ['food'] }, catalog), held)).toEqual([]);
    // the other way around: the budget was there first and the expense subject waits
    const budgetFirst = categoryReservations([subject({ id: 'b1', segment: 'budgets', name: 'Food', sourceId: 'bud', ...born('0001') }), subject({ id: 'e1', name: 'Consumption', catIds: ['food'], ...born('0002') })], budgets, catalog);
    expect(budgetFirst.get('food')).toMatchObject({ subjectId: 'b1', name: 'Food budget', segment: 'budgets' });
  });
});

describe('realization: one owner per slice (#557)', () => {
  const owners: SliceOwners = { recurringIds: new Set(['rec']), loanIds: new Set(['loan']), eventIds: new Set(['ev']), poolIds: new Set(['card']) };
  const slice = (over: Partial<TxSliceView>): TxSliceView =>
    ({ amountCents: -1000, catId: 'sub_food_a', effType: 'expense', fromParts: false, index: 0, count: 1, ...over }) as TxSliceView;

  it('a loan payment is the debt’s, a linked cost the recurring’s, an event’s money the event’s, the rest its category’s; a move to an own account is no spending', () => {
    expect(sliceOwner(slice({ linkedAccountId: 'loan', recurringId: 'rec' }), owners)).toEqual({ kind: 'debt', id: 'loan' });
    expect(sliceOwner(slice({ linkedAccountId: 'loan', amountCents: 5000 }), owners)).toBeNull();
    expect(sliceOwner(slice({ recurringId: 'rec', eventId: 'ev' }), owners)).toEqual({ kind: 'recurring', id: 'rec' });
    expect(sliceOwner(slice({ linkedAccountId: 'savings' }), owners)).toBeNull();
    // #532: paying the card that sits in the pool moves money inside the pool
    expect(sliceOwner(slice({ linkedAccountId: 'card', recurringId: 'rec' }), owners)).toBeNull();
    expect(sliceOwner(slice({ eventId: 'ev' }), owners)).toEqual({ kind: 'event', id: 'ev' });
    expect(sliceOwner(slice({ eventId: 'ev', effType: 'income', amountCents: 2000 }), owners)).toEqual({ kind: 'event', id: 'ev' });
    expect(sliceOwner(slice({ eventId: 'ev', effType: 'transfer' }), owners)).toBeNull();
    // a link to a source that is gone falls back to what the money is
    expect(sliceOwner(slice({ recurringId: 'deleted', eventId: 'gone' }), owners)).toEqual({ kind: 'category', catId: 'sub_food_a' });
    expect(sliceOwner(slice({ effType: 'income' }), owners)).toBeNull();
  });

  it('the ledger sums each owner once: refunds take off a category, an event is what it cost net of what came in, never below zero', () => {
    const txs = [
      tx({ id: '1', catId: 'sub_food_a', amountCents: -1200 }),
      tx({ id: '2', catId: 'sub_food_a', amountCents: -800, recurringId: 'rec' }),
      tx({ id: '3', catId: 'sub_food_a', amountCents: -500, linkedAccountId: 'loan', txType: 'debtPayment' }),
      tx({ id: '4', catId: 'sub_food_b', amountCents: -300 }),
      tx({ id: '5', catId: 'sub_food_a', amountCents: -300, date: '2026-09-30' }),
      tx({ id: '6', catId: 'sub_food_a', amountCents: 200 }),
      tx({ id: '7', catId: 'sub_food_a', amountCents: -4000, eventId: 'ev' }),
      tx({ id: '8', amountCents: 1500, eventId: 'ev', txType: 'income' }),
      tx({ id: '9', amountCents: 900, eventId: 'ev2', txType: 'income' }),
    ];
    const ledger = ledgerOf(txs, { recurringIds: new Set(['rec']), loanIds: new Set(['loan']), eventIds: new Set(['ev', 'ev2']) });
    expect(familySpentCents(new Set(['sub_food_a']), ledger)).toBe(1000);
    expect(familySpentCents(new Set(['sub_food_a', 'sub_food_b']), ledger, new Set(['sub_food_a']))).toBe(300);
    expect(ledger.byRecurring.get('rec')).toBe(800);
    expect(ledger.byDebt.get('loan')).toBe(500);
    expect(ledger.byEvent.get('ev')).toBe(2500);
    expect(ledger.byEvent.get('ev2')).toBe(0);
    // what an event cost before a date, for its target
    expect(eventNetBefore([tx({ id: 'a', amountCents: -700, eventId: 'ev', date: '2026-09-20' }), ...txs], 'ev', period.start, { ...NO_OWNERS, eventIds: new Set(['ev']) })).toBe(700);
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
      tx({ id: 'u6', date: '2026-10-07', amountCents: -12_00, catId: 'saving_sub' }),
    ];
    const rows = unplannedByCategory(ledgerOf(txs, { recurringIds: new Set(['rec1']) }), new Set(['movie']), {
      ...catalog,
      byId: (id: string | undefined) => (id === 'saving_sub' ? { id, parentId: 'saving' } : catalog.byId(id)),
    });
    expect(rows.map((r) => [r.mainId, r.cents])).toEqual([['consumption', 50_00]]);
    expect(rows[0].subs).toEqual([{ catId: 'groceries', cents: 40_00 }, { catId: 'coffee', cents: 10_00 }]);
    expect(unplannedKey(rows[0])).toBe('category:consumption');
  });

  describe('the Unplanned segment’s kinds (user 2026-10-09)', () => {
    const flat = {
      byId: (id: string | undefined) => ({ id: id ?? 'uncategorized', parentId: id === 'groceries' ? 'consumption' : undefined }),
      childrenOf: () => [],
    };
    const netflix = { id: 'rec1', name: 'Netflix', kind: 'subscription', icon: 'television-play', amountCents: 13_99, every: 'month', dueDay: 5, active: 1, ...envelope } as RecurringRow;
    const stopped = { ...netflix, id: 'rec2', name: 'Gym', active: 0 } as RecurringRow;
    const loan = account({ id: 'loan', name: 'Car loan', type: 'loan', color: '#C0392B', paymentCents: 250_00, paymentEvery: 'month', paymentDay: 10, balanceCents: -5000_00 });
    const trip = { id: 'g1', name: 'Trip', icon: 'airplane', color: '#27AE60', targetCents: 1000_00, allocatedCents: 0, ...envelope } as GoalRow;
    const contributions = [
      { id: 'c1', goalId: 'g1', amountCents: 100_00, date: '2026-10-05', ...envelope },
      { id: 'c0', goalId: 'g1', amountCents: 50_00, date: '2026-09-05', ...envelope },
    ] as GoalContributionRow[];
    const party = event({ id: 'ev1', name: 'Party', icon: 'party-popper', color: '#E91E63', archived: 1 });
    const txs = [
      tx({ id: 'u1', date: '2026-10-03', amountCents: -40_00, catId: 'groceries' }),
      // linked to a recurring cost: a recurring row, never groceries (the source wins over the category)
      tx({ id: 'n1', date: '2026-10-05', amountCents: -13_99, catId: 'groceries', recurringId: 'rec1' }),
      // a stopped recurring cost's last charge left the pool all the same: it stays in sight (#557)
      tx({ id: 'n2', date: '2026-10-06', amountCents: -20_00, catId: 'groceries', recurringId: 'rec2' }),
      tx({ id: 'l1', date: '2026-10-10', amountCents: -250_00, catId: 'groceries', linkedAccountId: 'loan', txType: 'debtPayment' }),
      // an event's money is the event's (#504), even when its category is groceries
      tx({ id: 'e1', date: '2026-10-11', amountCents: -60_00, catId: 'groceries', eventId: 'ev1' }),
    ];
    const ledger = ledgerOf(txs, { recurringIds: new Set(['rec1', 'rec2']), loanIds: new Set(['loan']), eventIds: new Set(['ev1']) });
    // an archived loan and an archived event still count: a subject could hold them, so their money never drops out
    const sources = { recurrings: [netflix, stopped], loans: [{ ...loan, archived: 1 as const }], events: [party], goals: [trip], contributions };

    it('a payment to a recurring cost is a recurring row, a transfer to a loan a debt row, an event’s money an event row, a contribution a goal row; the list reads in the plan’s order', () => {
      const rows = unplannedRows([], sources, ledger, period, new Set(), flat);
      expect(rows.map((r) => [r.kind, r.cents])).toEqual([
        ['recurring', 20_00],
        ['recurring', 13_99],
        ['debt', 250_00],
        ['category', 40_00],
        ['event', 60_00],
        ['goal', 100_00],
      ]);
      expect(rows[1]).toMatchObject({ sourceId: 'rec1', name: 'Netflix', icon: 'television-play' });
      expect(rows[2]).toMatchObject({ sourceId: 'loan', name: 'Car loan', color: '#C0392B' });
      expect(rows[3]).toMatchObject({ mainId: 'consumption', subs: [{ catId: 'groceries', cents: 40_00 }] });
      expect(rows[4]).toMatchObject({ sourceId: 'ev1', name: 'Party', icon: 'party-popper' });
      expect(rows[5]).toMatchObject({ sourceId: 'g1', name: 'Trip', icon: 'airplane', color: '#27AE60' });
      expect(rows.map(unplannedKey)).toEqual(['recurring:rec2', 'recurring:rec1', 'debt:loan', 'category:consumption', 'event:ev1', 'goal:g1']);
    });

    it('a source the plan mirrors leaves the segment — its subject counts the money from then on; a tombstoned or misfiled subject does not', () => {
      const mirrored = [
        subject({ id: 'sr', segment: 'recurring', sourceId: 'rec1' }),
        subject({ id: 'ss', segment: 'recurring', sourceId: 'rec2' }),
        subject({ id: 'sd', segment: 'debts', sourceId: 'loan' }),
        subject({ id: 'se', segment: 'events', sourceId: 'ev1' }),
        subject({ id: 'sg', segment: 'goals', sourceId: 'g1' }),
      ];
      expect(unplannedSources(mirrored, sources, ledger, period)).toEqual([]);
      const gone = [subject({ id: 'sr', segment: 'recurring', sourceId: 'rec1', deleted: 1 })];
      expect(unplannedSources(gone, sources, ledger, period).map((r) => r.sourceId)).toEqual(['rec2', 'rec1', 'loan', 'ev1', 'g1']);
      const misfiled = [subject({ id: 'x', segment: 'recurring', sourceId: 'g1' })];
      expect(unplannedSources(misfiled, sources, ledger, period).map((r) => r.kind)).toEqual(['recurring', 'recurring', 'debt', 'event', 'goal']);
      // nothing paid: nothing to plan
      const november = { start: '2026-11-01', end: '2026-11-30' };
      expect(unplannedSources([], sources, ledgerOf([], {}, november), november)).toEqual([]);
    });
  });

  it('a goal spreads what is left over the periods before its date; an undated goal has no target', () => {
    expect(goalTargetCents({ targetCents: 1200_00, allocatedCents: 300_00, targetDate: '2027-01-15' }, space, period)).toBe(225_00);
    expect(goalTargetCents({ targetCents: 100_00, allocatedCents: 100_00, targetDate: '2027-01-15' }, space, period)).toBe(0);
    expect(goalTargetCents({ targetCents: 100_00, allocatedCents: 0 }, space, period)).toBeNull();
  });

  it('an event spreads its estimate — or the person’s own total — over the periods until it starts, what it cost and what was set aside taken off (#504)', () => {
    // a trip in January, estimated at €1,200: four periods from October → a quarter now
    const trip = { from: '2027-01-10', to: '2027-01-20', budgetCents: 1200_00 };
    expect(eventTargetCents(trip, null, space, period, 0, 0)).toBe(300_00);
    // the person's own total wins over the estimate
    expect(eventTargetCents(trip, 800_00, space, period, 0, 0)).toBe(200_00);
    // a deposit already paid and money set aside earlier both come off
    expect(eventTargetCents(trip, null, space, period, 200_00, 200_00)).toBe(200_00);
    // under way or undated: all of what is left is due now
    expect(eventTargetCents({ from: '2026-09-25', to: '2026-10-05', budgetCents: 500_00 }, null, space, period, 0, 100_00)).toBe(400_00);
    expect(eventTargetCents({ budgetCents: 500_00 }, null, space, period, 0, 0)).toBe(500_00);
    // neither an estimate nor an own total: no target
    expect(eventTargetCents({ from: '2027-01-10' }, undefined, space, period, 0, 0)).toBeNull();
  });

  it('an event belongs to the periods it reaches, not after (the ticket’s example: Jun 15 – Jul 12 on periods starting the 21st)', () => {
    const summer = { from: '2027-06-15', to: '2027-07-12' };
    const may = { start: '2027-05-21', end: '2027-06-20' };
    const june = { start: '2027-06-21', end: '2027-07-20' };
    const july = { start: '2027-07-21', end: '2027-08-20' };
    expect([may, june, july].map((p) => eventInPeriod(summer, p))).toEqual([true, true, false]);
    expect([may, june, july].map((p) => isEventPast(summer, p))).toEqual([false, false, true]);
    // undated: any time, never past; one date: that day
    expect(isEventPast({}, july)).toBe(false);
    expect(eventInPeriod({}, july)).toBe(true);
    expect(isEventPast({ from: '2027-06-30' }, july)).toBe(true);
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

  it('spent past the target while the funding covers it is its own state — the green with orange stripes (#517)', () => {
    // the user’s Transportation: a €54.96 target, €145.79 spent and funded
    expect(subjectStatus('expenses', 54_96, 145_79, 145_79, false)).toBe('overTarget');
    expect(subjectStatus('budgets', 100_00, 150_00, 120_00, false)).toBe('overTarget');
    // money missing still reads red, whatever the target
    expect(subjectStatus('expenses', 54_96, 100_00, 145_79, false)).toBe('overspent');
    // no target to go past: plain funded
    expect(subjectStatus('expenses', 0, 30_00, 30_00, false)).toBe('funded');
  });
});

describe('the subject view', () => {
  const ctx = (over: Partial<SubjectContext> = {}): SubjectContext => ({
    space,
    period,
    ledger: ledgerOf([]),
    catalog,
    budgetsById: new Map(),
    recurringsById: new Map(),
    loansById: new Map(),
    eventsById: new Map(),
    goalsById: new Map(),
    contributions: [],
    poolIds: new Set(),
    eventSpentBefore: () => 0,
    carriedBySource: new Map(),
    budgetOpts: {},
    ...over,
  });

  it('an expense subject: its target, its spending, its colour', () => {
    const view = subjectView(subject({ catIds: ['sub_food_a'], targetCents: 50_00, fundedCents: 30_00 }), ctx({ ledger: ledgerOf([tx({ catId: 'sub_food_a', amountCents: -20_00 })]) }));
    expect(view).toMatchObject({ targetCents: 50_00, fundedCents: 30_00, realizedCents: 20_00, status: 'underfunded', orphaned: false, overlaps: [], inPool: false });
  });

  it('an event subject counts the event’s money — and the expense subject on the same category no longer does (#504)', () => {
    const txs = [tx({ id: 'd', catId: 'sub_food_a', amountCents: -80_00, eventId: 'ev' }), tx({ id: 'g', catId: 'sub_food_a', amountCents: -20_00 })];
    const c = ctx({ ledger: ledgerOf(txs, { eventIds: new Set(['ev']) }), eventsById: new Map([['ev', event({ from: '2026-10-20', to: '2026-10-22', budgetCents: 300_00 })]]) });
    const trip = subjectView(subject({ id: 'se', segment: 'events', sourceId: 'ev', fundedCents: 100_00 }), c);
    expect(trip).toMatchObject({ targetCents: 300_00, realizedCents: 80_00, dueThisPeriod: true, status: 'underfunded' });
    expect(subjectView(subject({ catIds: ['sub_food_a'], targetCents: 50_00 }), c).realizedCents).toBe(20_00);
    // a December event in October may be skipped; its own total spreads over the three periods
    const later = ctx({ eventsById: new Map([['ev', event({ from: '2026-12-05', budgetCents: 300_00 })]]) });
    const ahead = subjectView(subject({ id: 'se', segment: 'events', sourceId: 'ev', targetCents: 600_00 }), later);
    expect(ahead).toMatchObject({ targetCents: 200_00, dueThisPeriod: false });
    expect(canSkipPeriod(ahead)).toBe(true);
    expect(subjectView(subject({ segment: 'events', sourceId: 'gone' }), later).orphaned).toBe(true);
  });

  it('a subject blocked on categories an older one holds counts none of them and says whose they are (#535)', () => {
    const c = ctx({ ledger: ledgerOf([tx({ id: 'a', catId: 'sub_food_a', amountCents: -40_00 }), tx({ id: 'b', catId: 'sub_food_b', amountCents: -10_00 })]) });
    const holder = { subjectId: 'e1', name: 'Consumption', segment: 'expenses' as const };
    const reservations = new Map([['sub_food_a', holder]]);
    const blocked = subjectView(subject({ id: 'e2', catIds: ['food'], targetCents: 30_00, fundedCents: 30_00 }), c, reservations);
    expect(blocked.realizedCents).toBe(10_00);
    expect(blocked.overlaps).toEqual([{ holder, catIds: ['sub_food_a'] }]);
  });

  it('a loan in the money pool is no debt to plan: nothing to fund, its payments move money inside the pool (#532)', () => {
    const card = account({ id: 'card', type: 'credit', paymentCents: 50_00, paymentEvery: 'month', paymentDay: 10, balanceCents: -300_00 });
    const view = subjectView(subject({ segment: 'debts', sourceId: 'card' }), ctx({ loansById: new Map([['card', card]]), poolIds: new Set(['card']) }));
    expect(view).toMatchObject({ inPool: true, targetCents: 0, realizedCents: 0, orphaned: false });
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
    overlaps: [],
    inPool: false,
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
    const ledgers = past.map((p) => ledgerOf(txs, {}, p));
    expect(estimateTarget(new Set(['sub_food_a']), ledgers)).toEqual({ lastCents: 200_00, averageCents: 150_00 });
    expect(estimateTarget(new Set(['sub_food_a']), [])).toEqual({ lastCents: null, averageCents: null });
  });

  it('two plans are the same shape whatever their ids and order; a broken one names what is gone', () => {
    const a = [subject({ id: '1', catIds: ['food'], targetCents: 10 }), subject({ id: '2', segment: 'budgets', sourceId: 'b', order: 5 })];
    const b = [subject({ id: '9', segment: 'budgets', sourceId: 'b', order: 0 }), subject({ id: '8', catIds: ['food'], targetCents: 10, fundedCents: 99 })];
    expect(sameSubjects(a, b)).toBe(true);
    expect(sameSubjects(a, [a[0]])).toBe(false);
    const broken = brokenSubjects([...a, subject({ id: '3', catIds: ['vanished'] }), subject({ id: '4', segment: 'events', sourceId: 'gone' })], {
      catalog: { ...catalog, all: [{ id: 'food' }, { id: 'sub_food_a' }] },
      budgetIds: new Set(),
      recurringIds: new Set(),
      loanIds: new Set(),
      eventIds: new Set(),
      goalIds: new Set(),
    });
    expect(broken.map((s) => s.id)).toEqual(['2', '3', '4']);
  });

  it('a copy into a new period leaves behind what no longer matters: a past event, a paid-off or archived loan, a reached goal, a stopped cost (#557)', () => {
    const sources = {
      recurringsById: new Map([['on', { active: 1 as const }], ['off', { active: 0 as const }], ['ended', { active: 1 as const, until: '2026-09-30' }]]),
      loansById: new Map([['owed', { balanceCents: -100_00 }], ['paid', { balanceCents: 0 }], ['old', { balanceCents: -50_00, archived: 1 as const }], ['card', { balanceCents: -20_00 }]]),
      budgetsById: new Map([['b', { active: 1 as const }], ['paused', { active: 0 as const }]]),
      eventsById: new Map([['next', { from: '2026-12-01' }], ['over', { from: '2026-08-01', to: '2026-09-02' }], ['undated', {}]]),
      goalsById: new Map([['open', { allocatedCents: 10_00, targetCents: 100_00 }], ['reached', { allocatedCents: 100_00, targetCents: 100_00 }]]),
      poolIds: new Set(['card']),
    };
    const keep = (segment: PlanSubjectRow['segment'], sourceId?: string) => stillRelevant({ segment, sourceId }, period, sources);
    expect(['on', 'off', 'ended'].map((id) => keep('recurring', id))).toEqual([true, false, false]);
    expect(['owed', 'paid', 'old', 'card', 'gone'].map((id) => keep('debts', id))).toEqual([true, false, false, false, false]);
    expect(['b', 'paused'].map((id) => keep('budgets', id))).toEqual([true, false]);
    expect(['next', 'over', 'undated'].map((id) => keep('events', id))).toEqual([true, false, true]);
    expect(['open', 'reached'].map((id) => keep('goals', id))).toEqual([true, false]);
    expect(keep('expenses')).toBe(true);
  });

  it('recommends an expense subject per main the person spent on (a budget takes its place), every recurring cost and loan, the events to come, and goals only when the income leaves room', () => {
    const past = [{ start: '2026-09-01', end: '2026-09-30' }];
    const txs = [tx({ id: '1', catId: 'sub_food_a', amountCents: -300_00, date: '2026-09-10' }), tx({ id: '2', catId: 'sub_fun_a', amountCents: -50_00, date: '2026-09-12' })];
    const input = {
      catalog: { ...catalog, parents: [{ id: 'food' }, { id: 'fun' }, { id: 'quiet' }] },
      nameOf: (id: string) => id.toUpperCase(),
      pastLedgers: past.map((p) => ledgerOf(txs, {}, p)),
      budgets: [{ id: 'bud', name: 'Fun', amountCents: 80_00, every: 'period', anchor: '2026-01-01', catIds: ['fun'], active: 1, ...envelope } as BudgetRow],
      recurrings: [{ id: 'rec', name: 'Rent', kind: 'fixed', amountCents: 900_00, every: 'month', dueDay: 1, active: 1, ...envelope } as RecurringRow],
      accounts: [
        account({ id: 'loan', type: 'loan', paymentCents: 100_00, paymentEvery: 'month', paymentDay: 5, balanceCents: -5000_00 }),
        account({ id: 'card', name: 'Card', type: 'credit', paymentCents: 50_00, balanceCents: -300_00 }),
      ],
      poolIds: new Set(['card']),
      events: [event({ id: 'trip', name: 'Trip', from: '2027-01-10', budgetCents: 600_00 }), event({ id: 'old', name: 'Old', from: '2026-08-01', budgetCents: 100_00 }), event({ id: 'vague', name: 'Vague' })],
      goals: [{ id: 'g', name: 'Car', targetCents: 1000_00, allocatedCents: 0, ...envelope } as GoalRow],
      space,
      period,
    };
    const rich = recommendSubjects({ ...input, incomeCents: 5000_00 });
    // the card sits in the pool, the old event is over, the vague one has no estimate
    expect(rich.map((s) => `${s.segment}:${s.name}`)).toEqual(['recurring:Rent', 'debts:Main', 'expenses:FOOD', 'budgets:Fun', 'events:Trip', 'goals:Car']);
    expect(rich.find((s) => s.segment === 'expenses')?.targetCents).toBe(300_00);
    const tight = recommendSubjects({ ...input, incomeCents: 1000_00 });
    expect(tight.some((s) => s.segment === 'goals')).toBe(false);
    expect(recommendSubjects({ ...input, incomeCents: null }).some((s) => s.segment === 'goals')).toBe(false);
  });
});
