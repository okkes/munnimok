import { describe, expect, it } from 'vitest';
import type { AccountRow, GoalRow, TxView } from '@/db/types';
import {
  cashOutCandidates,
  cashOutCents,
  cashOutSet,
  goalCashOutsIn,
  goalOverview,
  goalPaidTxs,
  poolAfterCashOut,
  purchaseCandidates,
  monthsLeft,
  paceCentsPerPeriod,
  periodUnitKey,
  periodsLeft,
  poolAccounts,
  savingsTotalCents,
} from './goals';

const account = (partial: Partial<AccountRow>): AccountRow =>
  ({
    id: 'a',
    spaceId: 's1',
    name: 'Savings',
    type: 'savings',
    source: 'manual',
    currency: 'EUR',
    balanceCents: 0,
    deleted: 0,
    fieldVersions: {},
    ...partial,
  }) as AccountRow;

describe('#368: the savings pool behind the goals', () => {
  const accounts = [
    account({ id: 'manual', balanceCents: 50_000 }),
    account({ id: 'linked', source: 'connector', balanceCents: 20_000 }),
    account({ id: 'imported', source: 'camt053', balanceCents: 10_000 }),
    account({ id: 'gone', balanceCents: 99_999, archived: 1 }),
    account({ id: 'checking', type: 'checking', balanceCents: 99_999 }),
  ];

  it('with nothing picked every live savings account feeds the pool — manual, linked and imported alike', () => {
    expect(poolAccounts(accounts, undefined).map((a) => a.id)).toEqual(['manual', 'linked', 'imported']);
    expect(savingsTotalCents(accounts)).toBe(80_000);
  });

  it('a picked list narrows the pool to those accounts; an empty pick is an empty pool', () => {
    expect(savingsTotalCents(accounts, { goalPoolAccountIds: ['linked', 'checking'] })).toBe(20_000);
    expect(savingsTotalCents(accounts, { goalPoolAccountIds: [] })).toBe(0);
  });

  it('the overview reads the pool; a pool that shrank under its goals goes negative', () => {
    const goal = { id: 'g', spaceId: 's1', name: 'g', targetCents: 100_000, allocatedCents: 60_000, deleted: 0, fieldVersions: {} } as never;
    expect(goalOverview([goal], accounts, { goalPoolAccountIds: ['manual'] }).unallocatedCents).toBe(-10_000);
    expect(goalOverview([goal], accounts, undefined).unallocatedCents).toBe(20_000);
  });

  it('months left only needs the target date', () => {
    expect(monthsLeft({ targetDate: '2026-12-01' }, '2026-09-29')).toBe(3);
  });

  it('user 2026-10-04: the pace counts the space’s periods, this one and the one holding the deadline both', () => {
    const monthly = { periodType: 'month' as const, periodDay: 1 };
    // a deadline next month: this month and the next - two halves, not the lot at once
    expect(periodsLeft(monthly, '2026-11-15', '2026-10-04')).toBe(2);
    expect(periodsLeft(monthly, '2026-10-20', '2026-10-04')).toBe(1);
    expect(periodsLeft(monthly, '2027-01-02', '2026-10-04')).toBe(4);
    // a space that counts from the 25th: 4 October sits in the period that started 25 September
    const fromThe25th = { periodType: 'month' as const, periodDay: 25 };
    expect(periodsLeft(fromThe25th, '2026-11-01', '2026-10-04')).toBe(2);
    expect(periodsLeft(fromThe25th, '2026-10-20', '2026-10-04')).toBe(1);
    // weekly from Monday: 4 October is a Sunday, the deadline three Mondays on
    expect(periodsLeft({ periodType: 'week', periodDay: 1 }, '2026-10-20', '2026-10-04')).toBe(4);
    // the space not loaded yet reads as monthly from the 1st; undated is undated
    expect(periodsLeft(undefined, '2026-11-15', '2026-10-04')).toBe(2);
    expect(periodsLeft(monthly, undefined, '2026-10-04')).toBeNull();

    const goal = (over: Partial<GoalRow>): GoalRow => ({ id: 'g', spaceId: 's1', name: 'g', targetCents: 100_000, allocatedCents: 0, deleted: 0, fieldVersions: {}, ...over }) as GoalRow;
    expect(paceCentsPerPeriod(goal({ targetDate: '2026-11-15' }), monthly, '2026-10-04')).toBe(50_000);
    expect(paceCentsPerPeriod(goal({ targetDate: '2026-11-15', allocatedCents: 100_000 }), monthly, '2026-10-04')).toBe(0);
    expect(paceCentsPerPeriod(goal({}), monthly, '2026-10-04')).toBeNull();
    expect(periodUnitKey('week')).toBe('goals.unitWeek');
    expect(periodUnitKey('biweekly')).toBe('goals.unitBiweekly');
    expect(periodUnitKey('custom')).toBe('goals.unitPeriod');
    expect(periodUnitKey(undefined)).toBe('goals.unitMonth');
    expect(monthsLeft({}, '2026-09-29')).toBeNull();
  });
});

describe('#455: cashing out a reached goal', () => {
  const row = (partial: Partial<TxView>): TxView =>
    ({ id: 'x', spaceId: 's1', accountId: 'checking', date: '2026-10-12', amountCents: -1_000, currency: 'EUR', merchant: 'M', txType: 'expense', needsReview: 0, deleted: 0, fieldVersions: {}, ...partial }) as TxView;
  const savings = account({ id: 'savings', balanceCents: 200_000 });
  const checking = account({ id: 'checking', type: 'checking', name: 'Checking' });
  const accounts = [savings, checking];
  // the car: €18,000 moved from savings to checking, a linked pair
  const out = row({ id: 'out', accountId: 'savings', amountCents: -1_800_000, txType: 'saving', catId: 'savingWithdraw', transferPeerId: 'in' });
  const inLeg = row({ id: 'in', accountId: 'checking', amountCents: 1_800_000, txType: 'transfer', catId: 'transferIn', transferPeerId: 'out' });
  const goal = (over: Partial<GoalRow>): GoalRow =>
    ({ id: 'car', spaceId: 's1', name: 'Car', targetCents: 2_000_000, allocatedCents: 2_000_000, deleted: 0, fieldVersions: {}, ...over }) as GoalRow;
  const cashed = goal({ archived: 1, cashOut: { date: '2026-10-14', txIds: ['out'] } });

  it('the overview keeps both legs of a cashed-out pair out — the link may point either way', () => {
    expect([...cashOutSet([cashed], [out, inLeg])].sort()).toEqual(['in', 'out']);
    const oneWay = { ...inLeg, transferPeerId: undefined };
    expect([...cashOutSet([cashed], [out, oneWay])].sort()).toEqual(['in', 'out']);
    // a deleted goal takes its story with it; an undone cash-out holds nothing
    expect(cashOutSet([{ ...cashed, deleted: 1 }], [out, inLeg]).size).toBe(0);
    expect(cashOutSet([goal({ cashOut: null })], [out, inLeg]).size).toBe(0);
  });

  it('what left savings for the goal, per period — the money of the rows still there', () => {
    expect(cashOutCents(cashed, [out, inLeg])).toBe(1_800_000);
    expect(cashOutCents(cashed, [{ ...out, deleted: 1 }])).toBe(0);
    const october = { start: '2026-10-01', end: '2026-10-31' };
    expect(goalCashOutsIn([cashed, goal({ id: 'trip' })], [out, inLeg], october)).toEqual([{ goal: cashed, cents: 1_800_000 }]);
    expect(goalCashOutsIn([cashed], [out, inLeg], { start: '2026-11-01', end: '2026-11-30' })).toEqual([]);
  });

  it('the picker offers money that left the pool — one leg per pair, newest first; fees, reserved and taken rows stay out', () => {
    const fee = row({ id: 'fee', accountId: 'savings', amountCents: -250, txType: 'saving', catId: 'savingFees', date: '2026-10-01' });
    const reserved = row({ id: 'res', accountId: 'savings', amountCents: -50_000, txType: 'saving', catId: 'savingWithdraw', pending: 1 });
    const direct = row({ id: 'direct', accountId: 'savings', amountCents: -40_000, catId: 'electronics', date: '2026-10-13' });
    // a withdrawal filed on checking whose savings leg the space does not track
    const bare = row({ id: 'bare', accountId: 'checking', amountCents: 30_000, txType: 'saving', catId: 'savingWithdraw', date: '2026-09-20' });
    const deposit = row({ id: 'dep', accountId: 'checking', amountCents: -20_000, txType: 'saving', catId: 'savingDeposit' });
    const old = row({ id: 'old', accountId: 'savings', amountCents: -10_000, txType: 'saving', catId: 'savingWithdraw', date: '2025-08-01' });
    const all = [out, inLeg, fee, reserved, direct, bare, deposit, old];
    const picks = cashOutCandidates(all, accounts, undefined, [], '2026-10-20');
    expect(picks.map((t) => t.id)).toEqual(['direct', 'out', 'bare']);
    // a row another goal already cashed out is spoken for
    expect(cashOutCandidates(all, accounts, undefined, [cashed], '2026-10-20').map((t) => t.id)).toEqual(['direct', 'bare']);
    // the pool is the ticked set: an unticked savings account is not the goals' money
    expect(cashOutCandidates(all, accounts, { goalPoolAccountIds: [] }, [], '2026-10-20').map((t) => t.id)).toEqual(['bare']);
  });

  it('what the money bought is picked from the spending outside the pool — newest first; moves, income, reserved rows and another goal’s purchase stay out', () => {
    const car = row({ id: 'car', amountCents: -1_800_000, catId: 'transport', date: '2026-10-13' });
    const lunch = row({ id: 'lunch', amountCents: -1_500, catId: 'food', date: '2026-10-14' });
    const reserved = row({ id: 'res', amountCents: -9_000, pending: 1 });
    const salary = row({ id: 'sal', amountCents: 300_000, txType: 'income' });
    const toLoan = row({ id: 'loan', amountCents: -20_000, txType: 'debtPayment', linkedAccountId: 'mortgage' });
    const fromSavings = row({ id: 'direct', accountId: 'savings', amountCents: -40_000, catId: 'electronics' });
    const ancient = row({ id: 'old', amountCents: -5_000, date: '2025-08-01' });
    const all = [car, lunch, reserved, salary, toLoan, fromSavings, ancient, out, inLeg];
    expect(purchaseCandidates(all, accounts, undefined, [], '2026-10-20').map((t) => t.id)).toEqual(['lunch', 'car']);
    // another goal already named the car; the goal being edited keeps its own picks in the list
    const bought = goal({ id: 'car', archived: 1, cashOut: { date: '2026-10-14', txIds: ['out'], purchaseTxIds: ['car'] } });
    expect(purchaseCandidates(all, accounts, undefined, [bought], '2026-10-20').map((t) => t.id)).toEqual(['lunch']);
    expect(purchaseCandidates(all, accounts, undefined, [bought], '2026-10-20', 'car').map((t) => t.id)).toEqual(['lunch', 'car']);
  });

  it('every row a goal answers for names its goal: what left savings and what that bought', () => {
    const bought = goal({ archived: 1, cashOut: { date: '2026-10-14', txIds: ['out'], purchaseTxIds: ['car'] } });
    const paid = goalPaidTxs([bought, goal({ id: 'trip' }), goal({ id: 'gone', deleted: 1, cashOut: { date: '2026-10-14', txIds: ['x'] } })]);
    expect([...paid]).toEqual([['out', 'car'], ['car', 'car']]);
  });

  it('the pool after a cash-out: the goal lets go of what it held — more than that comes out of the unallocated savings, below zero when they run out', () => {
    // €2,000 in savings after the withdrawal; this goal held 20,000, another holds 1,500
    const others = [goal({}), goal({ id: 'trip', allocatedCents: 150_000 })];
    const pool = [account({ id: 'savings', balanceCents: 200_000 })];
    expect(goalOverview(others, pool).unallocatedCents).toBe(-1_950_000);
    expect(poolAfterCashOut(others[0], others, pool)).toBe(50_000);
    // €1,000 left: the other goal's 1,500 no longer fits — the pool reads −500 and the other goal keeps its money
    expect(poolAfterCashOut(others[0], others, [account({ id: 'savings', balanceCents: 100_000 })])).toBe(-50_000);
  });
});
