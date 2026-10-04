import { describe, expect, it } from 'vitest';
import type { AccountRow, GoalRow } from '@/db/types';
import { goalOverview, monthsLeft, paceCentsPerPeriod, periodUnitKey, periodsLeft, poolAccounts, savingsTotalCents } from './goals';

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
