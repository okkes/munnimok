import { describe, expect, it } from 'vitest';
import type { AccountRow } from '@/db/types';
import { compareStrategies, extraLadder, monthAfter, orderDebts, simulateBaseline, simulatePlan, toPlanDebts } from './debtPlan';
import type { PlanDebt } from './debtPlan';

const debt = (partial: Partial<PlanDebt> & { id: string }): PlanDebt => ({
  name: partial.id,
  balanceCents: 100_000,
  aprPct: 5,
  aprKnown: true,
  minMonthlyCents: 10_000,
  ...partial,
});

// a car loan, a credit card, a small family loan: the three orders disagree
const car = debt({ id: 'car', balanceCents: 1_000_000, aprPct: 5, minMonthlyCents: 25_000 });
const card = debt({ id: 'card', balanceCents: 300_000, aprPct: 18, minMonthlyCents: 9_000 });
const family = debt({ id: 'family', balanceCents: 150_000, aprPct: 0, minMonthlyCents: 5_000, stress: 5 });
const three = [car, card, family];

describe('the payoff order', () => {
  it('avalanche takes the highest interest first, snowball the smallest balance, tsunami the heaviest on the person', () => {
    expect(orderDebts(three, 'avalanche').map((d) => d.id)).toEqual(['card', 'car', 'family']);
    expect(orderDebts(three, 'snowball').map((d) => d.id)).toEqual(['family', 'card', 'car']);
    expect(orderDebts(three, 'tsunami').map((d) => d.id)).toEqual(['family', 'card', 'car']);
  });

  it('tsunami: an unranked debt sits in the middle; equal weight falls back to the interest', () => {
    const heavy = debt({ id: 'heavy', aprPct: 2, stress: 4 });
    const light = debt({ id: 'light', aprPct: 30, stress: 1 });
    const unranked = debt({ id: 'unranked', aprPct: 9 });
    expect(orderDebts([light, unranked, heavy], 'tsunami').map((d) => d.id)).toEqual(['heavy', 'unranked', 'light']);
    const a = debt({ id: 'a', aprPct: 3, stress: 3 });
    const b = debt({ id: 'b', aprPct: 7, stress: 3 });
    expect(orderDebts([a, b], 'tsunami').map((d) => d.id)).toEqual(['b', 'a']);
  });
});

describe('the walk', () => {
  it('one debt: a fixed payment against monthly interest ends where the loan math says', () => {
    // 10 000 at 12%: 100 a month of interest at first; 300 a month clears it in 41 months
    const r = simulatePlan([debt({ id: 'one', balanceCents: 1_000_000, aprPct: 12, minMonthlyCents: 30_000 })], { strategy: 'avalanche' });
    expect(r.months).toBe(41);
    expect(r.balances).toHaveLength(42);
    expect(r.balances[0]).toBe(1_000_000);
    expect(r.balances.at(-1)).toBe(0);
    expect(r.totalPaidCents).toBe(1_000_000 + r.totalInterestCents);
    expect(r.debts[0]).toMatchObject({ id: 'one', paidOffMonth: 41, order: 1, stuck: false });
    expect(r.minimumsCents).toBe(30_000);
  });

  it('the rollover: a freed minimum feeds the next debt, so the plan beats paying the minimums apart', () => {
    const plan = simulatePlan(three, { strategy: 'avalanche' });
    const baseline = simulateBaseline(three);
    expect(plan.months).not.toBeNull();
    expect(baseline.months).not.toBeNull();
    expect(plan.months!).toBeLessThan(baseline.months!);
    expect(plan.totalInterestCents).toBeLessThan(baseline.totalInterestCents);
    // the card goes first under avalanche, and the car (the biggest) last
    const byId = Object.fromEntries(plan.debts.map((d) => [d.id, d]));
    expect(byId.card.paidOffMonth!).toBeLessThan(byId.car.paidOffMonth!);
    expect(plan.debts.map((d) => d.order)).toEqual([1, 2, 3]);
  });

  it('extra per month and a one-off extra shorten the plan and cut the interest', () => {
    const plain = simulatePlan(three, { strategy: 'snowball' });
    const extra = simulatePlan(three, { strategy: 'snowball', extraMonthlyCents: 20_000 });
    const lump = simulatePlan(three, { strategy: 'snowball', lumpSumCents: 500_000 });
    expect(extra.months!).toBeLessThan(plain.months!);
    expect(extra.totalInterestCents).toBeLessThan(plain.totalInterestCents);
    expect(lump.months!).toBeLessThan(plain.months!);
    expect(lump.balances[1]).toBeLessThan(plain.balances[1] - 400_000);
  });

  it('a minimum that does not cover the interest never pays off: no end month, the debt is marked stuck, the walk stops after a flat year', () => {
    const r = simulatePlan([debt({ id: 'trap', balanceCents: 1_000_000, aprPct: 24, minMonthlyCents: 10_000 })], { strategy: 'avalanche' });
    expect(r.months).toBeNull();
    expect(r.debts[0].stuck).toBe(true);
    expect(r.debts[0].paidOffMonth).toBeNull();
    expect(r.balances.length).toBeLessThan(20);
    // the same debt with enough extra is fine
    const saved = simulatePlan([debt({ id: 'trap', balanceCents: 1_000_000, aprPct: 24, minMonthlyCents: 10_000 })], { strategy: 'avalanche', extraMonthlyCents: 30_000 });
    expect(saved.months).not.toBeNull();
    expect(saved.debts[0].stuck).toBe(false);
  });

  it('the horizon caps the walk; a debt without a balance is not in the plan', () => {
    const r = simulatePlan([debt({ id: 'slow', balanceCents: 10_000_000, aprPct: 0, minMonthlyCents: 1_000 })], { strategy: 'avalanche', maxMonths: 24 });
    expect(r.months).toBeNull();
    expect(r.balances).toHaveLength(25);
    expect(simulatePlan([debt({ id: 'gone', balanceCents: 0 })], { strategy: 'avalanche' })).toMatchObject({ months: 0, debts: [], balances: [0] });
  });

  it('the three orders compared share the extra; avalanche never pays more interest than the other two', () => {
    const c = compareStrategies(three, { extraMonthlyCents: 10_000 });
    expect(c.avalanche.totalInterestCents).toBeLessThanOrEqual(c.snowball.totalInterestCents);
    expect(c.avalanche.totalInterestCents).toBeLessThanOrEqual(c.tsunami.totalInterestCents);
    expect(c.snowball.debts[0].id).toBe('family');
  });

  it('the ladder: every step more per month ends sooner or equal and never costs more interest', () => {
    const steps = extraLadder(three, { strategy: 'avalanche', extraMonthlyCents: 5_000 }, [2_500, 5_000, 10_000, 25_000]);
    expect(steps.map((s) => s.moreCents)).toEqual([2_500, 5_000, 10_000, 25_000]);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].months!).toBeLessThanOrEqual(steps[i - 1].months!);
      expect(steps[i].totalInterestCents).toBeLessThanOrEqual(steps[i - 1].totalInterestCents);
    }
  });

  it('monthAfter walks whole months, across a year end', () => {
    expect(monthAfter('2026-10-01', 0)).toBe('2026-10');
    expect(monthAfter('2026-10-15', 3)).toBe('2027-01');
    expect(monthAfter('2026-10-15', 14)).toBe('2027-12');
  });
});

describe('from the accounts', () => {
  const account = (partial: Partial<AccountRow>): AccountRow =>
    ({ id: 'x', spaceId: 's', name: 'x', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: 0, deleted: 0, fieldVersions: {}, ...partial }) as AccountRow;

  it('the active tracked loans become plan debts: remaining as the balance, the APR (unknown = 0, said so), the cadence-normalized payment, the weight', () => {
    const debts = toPlanDebts([
      { account: account({ id: 'a', name: 'Car', interestPctYear: 4.5, paymentCents: 10_000, paymentEvery: 'week', debtStress: 2 }), remainingCents: 500_000 },
      { account: account({ id: 'b', name: 'Family' }), remainingCents: 20_000 },
      { account: account({ id: 'c', name: 'Done', archived: 1, interestPctYear: 3 }), remainingCents: 100 },
      { account: account({ id: 'd', name: 'Paid', interestPctYear: 3 }), remainingCents: 0 },
    ]);
    expect(debts.map((d) => d.id)).toEqual(['a', 'b']);
    expect(debts[0]).toMatchObject({ balanceCents: 500_000, aprPct: 4.5, aprKnown: true, minMonthlyCents: 43_333, stress: 2 });
    expect(debts[1]).toMatchObject({ aprPct: 0, aprKnown: false, minMonthlyCents: 0, stress: undefined });
  });
});
