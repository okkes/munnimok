import { describe, expect, it } from 'vitest';
import type { BudgetRow, TxView } from '@/db/types';
import {
  budgetFamily,
  budgetPayments,
  budgetPeriodAt,
  budgetSpentCents,
  budgetStatus,
  carriedCents,
  carryCapFor,
  categoryConflicts,
  periodMaxOf,
  currentBudgetPeriod,
  sortByUrgency,
} from './budgets';

const budget = (partial: Partial<BudgetRow>): BudgetRow =>
  ({
    id: 'b1',
    spaceId: 's1',
    name: 'Groceries',
    amountCents: 10_000,
    every: 'week',
    anchor: '2026-06-01', // a Monday
    catIds: ['groceries'],
    active: 1,
    deleted: 0,
    fieldVersions: {},
    ...partial,
  }) as BudgetRow;

const tx = (date: string, amountCents: number, catId = 'groceries'): TxView =>
  ({
    id: `t${date}-${amountCents}`,
    spaceId: 's1',
    accountId: 'a',
    date,
    amountCents,
    currency: 'EUR',
    merchant: 'x',
    catId,
    txType: 'expense',
    needsReview: 0,
    deleted: 0,
    fieldVersions: {},
  }) as TxView;

const catalog = {
  byId: (id: string | undefined) => ({ id: id ?? '', parentId: id === 'supermarket' ? 'groceries' : undefined }),
  childrenOf: (id: string) => (id === 'groceries' ? [{ id: 'supermarket' }] : []),
};

describe('budget periods', () => {
  it('weekly periods walk from the anchor date', () => {
    const b = budget({ every: 'week', anchor: '2026-06-01' });
    expect(budgetPeriodAt(b, 0)).toEqual({ start: '2026-06-01', end: '2026-06-07' });
    expect(budgetPeriodAt(b, 2)).toEqual({ start: '2026-06-15', end: '2026-06-21' });
    expect(currentBudgetPeriod(b, '2026-06-10')).toEqual({ start: '2026-06-08', end: '2026-06-14' });
  });

  it('biweekly periods are 14 days long', () => {
    const b = budget({ every: '2weeks', anchor: '2026-06-01' });
    expect(budgetPeriodAt(b, 1)).toEqual({ start: '2026-06-15', end: '2026-06-28' });
  });

  it('monthly periods clamp the anchor day into short months', () => {
    const b = budget({ every: 'month', anchor: '2026-01-31' });
    expect(budgetPeriodAt(b, 1)).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    // before the anchor day, today still belongs to the previous cycle
    expect(currentBudgetPeriod(b, '2026-03-15')).toEqual({ start: '2026-02-28', end: '2026-03-30' });
    expect(currentBudgetPeriod(b, '2026-03-31')).toEqual({ start: '2026-03-31', end: '2026-04-29' });
  });

  it('#371: a monthly budget started mid-month resets on its own day — the first period is the short one', () => {
    const b = budget({ every: 'month', anchor: '2026-06-15', resetDay: 1 });
    expect(budgetPeriodAt(b, 0)).toEqual({ start: '2026-06-15', end: '2026-06-30' });
    expect(budgetPeriodAt(b, 1)).toEqual({ start: '2026-07-01', end: '2026-07-31' });
    expect(currentBudgetPeriod(b, '2026-08-20')).toEqual({ start: '2026-08-01', end: '2026-08-31' });
    // before the start date, the first period
    expect(currentBudgetPeriod(b, '2026-06-10')).toEqual({ start: '2026-06-15', end: '2026-06-30' });
  });

  it('#370: weekly budgets start their full weeks on the space\'s first weekday — the start date opens a partial week', () => {
    const wednesday = budget({ every: 'week', anchor: '2026-06-03' });
    expect(budgetPeriodAt(wednesday, 0)).toEqual({ start: '2026-06-03', end: '2026-06-07' });
    expect(budgetPeriodAt(wednesday, 1)).toEqual({ start: '2026-06-08', end: '2026-06-14' });
    expect(budgetPeriodAt(wednesday, 1, { weekStart: 'sunday' })).toEqual({ start: '2026-06-07', end: '2026-06-13' });
    expect(currentBudgetPeriod(wednesday, '2026-06-07', { weekStart: 'sunday' })).toEqual({ start: '2026-06-07', end: '2026-06-13' });
    const biweekly = budget({ every: '2weeks', anchor: '2026-06-03' });
    expect(budgetPeriodAt(biweekly, 1)).toEqual({ start: '2026-06-08', end: '2026-06-21' });
  });

  it('#369: the "period" cadence follows the space\'s own budget period', () => {
    const b = budget({ every: 'period', anchor: '2026-06-10' });
    const monthlyFrom25 = { spacePeriod: { periodType: 'month' as const, periodDay: 25 } };
    expect(budgetPeriodAt(b, 0, monthlyFrom25)).toEqual({ start: '2026-06-10', end: '2026-06-24' });
    expect(budgetPeriodAt(b, 1, monthlyFrom25)).toEqual({ start: '2026-06-25', end: '2026-07-24' });
    const weeklyFromMonday = { spacePeriod: { periodType: 'week' as const, periodDay: 1 } };
    expect(budgetPeriodAt(b, 1, weeklyFromMonday)).toEqual({ start: '2026-06-15', end: '2026-06-21' });
    expect(currentBudgetPeriod(b, '2026-07-30', monthlyFrom25)).toEqual({ start: '2026-07-25', end: '2026-08-24' });
  });
});

describe('spent + family', () => {
  it('a main category claims its subs; refunds reduce spending', () => {
    const family = budgetFamily(['groceries'], catalog);
    expect(family.has('supermarket')).toBe(true);
    const spent = budgetSpentCents(
      [tx('2026-06-02', -2500), tx('2026-06-03', -1000, 'supermarket'), tx('2026-06-04', 500), tx('2026-06-04', -999, 'transport')],
      family,
      { start: '2026-06-01', end: '2026-06-07' },
    );
    expect(spent).toBe(3000); // 2500 + 1000 − 500, transport ignored
  });

  it('#579: the payments list is exactly the money the budget counts — a split part in the budget is a line of its own', () => {
    const family = budgetFamily(['groceries'], catalog);
    const period = { start: '2026-06-01', end: '2026-06-07' };
    // a dinner split: €30 groceries (the budget's), €70 transport (the row's shadow category)
    const split = {
      ...tx('2026-06-05', -10_000, 'transport'),
      id: 'split',
      splits: [
        { id: 'p1', catId: 'transport', amountCents: 7000 },
        { id: 'p2', catId: 'groceries', amountCents: 3000 },
      ],
    } as TxView;
    // a spread row: one transaction, €12 of it in the budget
    const spread = {
      ...tx('2026-06-03', -2000, 'transport'),
      id: 'spread',
      cats: [
        { catId: 'transport', amountCents: 800 },
        { catId: 'supermarket', amountCents: 1200 },
      ],
    } as TxView;
    const txs = [tx('2026-06-02', -2500), split, spread, tx('2026-06-04', 500), tx('2026-06-04', -999, 'transport'), tx('2026-06-09', -100)];
    const payments = budgetPayments(txs, family, period);
    expect(payments.map((p) => [p.tx.id, p.part?.id, p.spentCents])).toEqual([
      ['split', 'p2', 3000],
      ['t2026-06-04-500', undefined, -500],
      ['spread', undefined, 1200],
      ['t2026-06-02--2500', undefined, 2500],
    ]);
    expect(payments.reduce((sum, p) => sum + p.spentCents, 0)).toBe(budgetSpentCents(txs, family, period));
  });
});

describe('carry-over replay', () => {
  it("mode 'periods' carries leftovers at most N cycles", () => {
    // limit 100/week: week0 spends 40 (leftover 60), week1 spends 0
    const txs = [tx('2026-06-02', -4000)];
    const withOne = budget({ carryOver: 1, carryMode: 'periods', carryPeriods: 1 });
    // in week1 the 60 from week0 is available…
    expect(carriedCents(withOne, txs, budgetFamily(['groceries'], catalog), '2026-06-10')).toBe(6000);
    // …but with N=1, by week2 only week1's (untouched full) leftover counts
    expect(carriedCents(withOne, txs, budgetFamily(['groceries'], catalog), '2026-06-17')).toBe(10_000);
  });

  it("mode 'cap' accumulates but never beyond the cap", () => {
    const capped = budget({ carryOver: 1, carryMode: 'cap', carryCapCents: 12_000 });
    // three empty weeks would carry 300 — the cap holds it at 120
    expect(carriedCents(capped, [], budgetFamily(['groceries'], catalog), '2026-06-24')).toBe(12_000);
  });

  it('#534: the maximum is the most a period may hold — the coffee budget of the ticket, week by week', () => {
    // €20 a week, never more than €50 in a week; the weeks spend 10, 5, 8 and 38
    const coffee = budget({ amountCents: 2000, carryOver: 1, carryMode: 'cap', carryCapCents: carryCapFor(5000, 2000) });
    const family = budgetFamily(['groceries'], catalog);
    const txs = [tx('2026-06-02', -1000), tx('2026-06-09', -500), tx('2026-06-16', -800), tx('2026-06-23', -3800)];
    const holds = (today: string) => coffee.amountCents + carriedCents(coffee, txs, family, today);
    expect(holds('2026-06-08')).toBe(3000);
    expect(holds('2026-06-15')).toBe(4500);
    // 45 − 8 + 20 would be 57: the maximum holds it at 50
    expect(holds('2026-06-22')).toBe(5000);
    expect(holds('2026-06-29')).toBe(3200);
  });

  it('#534: a stored budget shows the same maximum it always had in effect: what may pile up, plus the period\'s own amount', () => {
    const stored = budget({ amountCents: 2000, carryOver: 1, carryMode: 'cap', carryCapCents: 5000 });
    expect(periodMaxOf(stored)).toBe(7000);
    expect(carryCapFor(7000, 2000)).toBe(5000);
    // a maximum that leaves no room above the amount piles nothing up
    expect(carryCapFor(2000, 2000)).toBe(0);
    expect(carryCapFor(1500, 2000)).toBe(0);
    expect(periodMaxOf(budget({ carryOver: 1, carryMode: 'periods' }))).toBeNull();
  });

  it('overspending eats into the carried amount, never below zero', () => {
    const b = budget({ carryOver: 1, carryMode: 'periods', carryPeriods: 2 });
    // week0: spend 150 of 100 → leftover clamps to 0 (no debt carried)
    const txs = [tx('2026-06-02', -15_000)];
    expect(carriedCents(b, txs, budgetFamily(['groceries'], catalog), '2026-06-10')).toBe(0);
  });

  it('no carry before the second period or when disabled', () => {
    expect(carriedCents(budget({}), [], budgetFamily(['groceries'], catalog), '2026-06-10')).toBe(0);
    expect(carriedCents(budget({ carryOver: 1 }), [], budgetFamily(['groceries'], catalog), '2026-06-03')).toBe(0);
  });
});

describe('status + urgency', () => {
  it('computes limit, left and ratio with carry-over included', () => {
    const b = budget({ carryOver: 1, carryMode: 'periods', carryPeriods: 1 });
    const txs = [tx('2026-06-02', -4000), tx('2026-06-09', -12_000)];
    const status = budgetStatus(b, txs, catalog, '2026-06-10');
    expect(status.carriedCents).toBe(6000);
    expect(status.limitCents).toBe(16_000);
    expect(status.leftCents).toBe(4000);
    expect(status.ratio).toBeCloseTo(0.75);
  });

  it('orders over-budget first, then closest to the limit', () => {
    const mk = (name: string, spent: number) =>
      budgetStatus(budget({ id: name, name, catIds: ['groceries'] }), [tx('2026-06-02', -spent)], catalog, '2026-06-03');
    const sorted = sortByUrgency([mk('calm', 1000), mk('over', 15_000), mk('close', 9000)]);
    expect(sorted.map((s) => s.budget.name)).toEqual(['over', 'close', 'calm']);
  });
});

describe('category exclusivity', () => {
  it('flags direct claims and main↔sub family overlaps with the owner name', () => {
    const other = budget({ id: 'b2', name: 'Food', catIds: ['supermarket'] });
    const conflicts = categoryConflicts(['groceries', 'transport'], [other], catalog);
    // picking the MAIN conflicts because Food owns one of its subs
    expect(conflicts.get('groceries')).toBe('Food');
    expect(conflicts.has('transport')).toBe(false);
  });
});
