import { describe, expect, it } from 'vitest';
import type { AccountRow } from '@/db/types';
import { goalOverview, monthsLeft, poolAccounts, savingsTotalCents } from './goals';

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
    expect(monthsLeft({}, '2026-09-29')).toBeNull();
  });
});
