import { describe, expect, it } from 'vitest';
import type { AccountRow } from '@/db/types';
import {
  STRATEGIES,
  chartHorizon,
  compareStrategies,
  extraLadder,
  monthAfter,
  monthTicks,
  orderDebts,
  sampleMonths,
  sampleStep,
  simulateBaseline,
  simulatePlan,
  toPlanDebts,
  yearTicks,
} from './debtPlan';
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

describe('an extra aimed at one debt (user 2026-10-08)', () => {
  const carOf = (r: ReturnType<typeof simulatePlan>) => r.debts.find((d) => d.id === 'car')!;

  it('shortens that debt and the whole plan, lands on top of its minimum, and the per-debt walks add up to the total every month', () => {
    const plain = simulatePlan(three, { strategy: 'avalanche' });
    const aimed = simulatePlan(three, { strategy: 'avalanche', extraByDebtCents: { car: 20_000 } });
    expect(carOf(aimed).paidOffMonth!).toBeLessThan(carOf(plain).paidOffMonth!);
    expect(aimed.months!).toBeLessThan(plain.months!);
    expect(aimed.totalInterestCents).toBeLessThan(plain.totalInterestCents);
    // month 1 on the car (last in the avalanche order, so the pool never reaches it): its
    // interest accrues, then the minimum AND the extra aimed at it land
    expect(aimed.balancesByDebt.car[0]).toBe(1_000_000);
    expect(aimed.balancesByDebt.car[1]).toBe(1_000_000 + Math.round((1_000_000 * 5) / 100 / 12) - 25_000 - 20_000);
    expect(plain.balancesByDebt.car[1]).toBe(1_000_000 + Math.round((1_000_000 * 5) / 100 / 12) - 25_000);
    // every debt's walk is as long as the total's, and they sum to it month by month
    for (const walk of Object.values(aimed.balancesByDebt)) expect(walk).toHaveLength(aimed.balances.length);
    for (let m = 0; m < aimed.balances.length; m++) {
      const sum = Object.values(aimed.balancesByDebt).reduce((acc, walk) => acc + walk[m], 0);
      expect(sum).toBe(aimed.balances[m]);
    }
  });

  it('once the aimed debt is gone its extra feeds the pool like a freed minimum; what it did not need this month goes there too', () => {
    const plain = simulatePlan(three, { strategy: 'avalanche' });
    // the family loan (1 500 at 0%) is gone in month 1 with €2 000 aimed at it
    const aimed = simulatePlan(three, { strategy: 'avalanche', extraByDebtCents: { family: 200_000 } });
    expect(aimed.debts.find((d) => d.id === 'family')!.paidOffMonth).toBe(1);
    // month 1: of the 5 000 + 200 000 only 150 000 was needed; the 55 000 left went to the card (first in the order)
    expect(aimed.balancesByDebt.card[1]).toBe(plain.balancesByDebt.card[1] - 55_000);
    // month 2: the family's whole 205 000 keeps flowing into the plan
    expect(aimed.balancesByDebt.card[2]).toBeLessThan(plain.balancesByDebt.card[2] - 200_000);
    // the baseline knows nothing of it: minimums only
    expect(simulateBaseline(three).balancesByDebt.family[1]).toBe(145_000);
  });

  it('a payment that only beats its interest together with the aimed extra is not stuck; the comparison and the ladder carry the extra along', () => {
    const trap = debt({ id: 'trap', balanceCents: 1_000_000, aprPct: 24, minMonthlyCents: 10_000 });
    expect(simulatePlan([trap], { strategy: 'avalanche' }).debts[0].stuck).toBe(true);
    const saved = simulatePlan([trap], { strategy: 'avalanche', extraByDebtCents: { trap: 30_000 } });
    expect(saved.debts[0].stuck).toBe(false);
    expect(saved.months).not.toBeNull();
    const plainCar = carOf(simulatePlan(three, { strategy: 'avalanche' })).paidOffMonth!;
    const compared = compareStrategies(three, { extraByDebtCents: { car: 20_000 } });
    for (const s of STRATEGIES) expect(carOf(compared[s]).paidOffMonth!).toBeLessThan(plainCar);
    const aimed = simulatePlan(three, { strategy: 'avalanche', extraByDebtCents: { car: 20_000 } });
    const [step] = extraLadder(three, { strategy: 'avalanche', extraByDebtCents: { car: 20_000 } }, [2_500]);
    expect(step.months!).toBeLessThanOrEqual(aimed.months!);
    expect(step.totalInterestCents).toBeLessThan(aimed.totalInterestCents);
  });
});

describe('the chart grid (user 2026-10-08)', () => {
  it('the horizon follows the plan with room, never the whole minimums-only walk', () => {
    // a three-month plan against thirty years: nine months, not a cliff at the left edge
    expect(chartHorizon(3, 360)).toBe(9);
    expect(chartHorizon(24, 360)).toBe(72);
    expect(chartHorizon(200, 360)).toBe(360);
    // room past the end, but never past the baseline
    expect(chartHorizon(24, 26)).toBe(26);
    // a plan longer than the baseline keeps its own length
    expect(chartHorizon(30, 20)).toBe(30);
    expect(chartHorizon(0, 0)).toBe(1);
  });

  it('sampling: one value per step up to the horizon, the last value holding past the walk', () => {
    expect(sampleStep(9)).toBe(1);
    expect(sampleStep(360)).toBe(3);
    expect(sampleStep(600)).toBe(5);
    expect(sampleMonths([100, 50, 0], 1, 5)).toEqual([100, 50, 0, 0, 0, 0]);
    expect(sampleMonths([100, 80, 60, 40, 20, 0], 2, 9)).toEqual([100, 60, 20, 0, 0]);
    expect(sampleMonths([], 1, 5)).toEqual([]);
  });

  it('year ticks: the start, then every 1, 2, 5 or 10 years — at most six, evenly spaced, never neighbours', () => {
    const thirty = yearTicks(360, 3, '2026-10-08');
    expect(thirty[0]).toEqual({ index: 0, label: '2026' });
    expect(thirty.map((t) => t.label)).toEqual(['2026', '2036', '2046', '2056']);
    expect(thirty.map((t) => t.index)).toEqual([0, 40, 80, 120]);
    expect(yearTicks(24, 1, '2026-10-08')).toEqual([
      { index: 0, label: '2026' },
      { index: 12, label: '2027' },
      { index: 24, label: '2028' },
    ]);
    // seven years at one per year would be seven labels: every other year then
    expect(yearTicks(72, 1, '2026-10-08').map((t) => t.label)).toEqual(['2026', '2028', '2030', '2032']);
    expect(yearTicks(120, 1, '2026-10-08').map((t) => t.label)).toEqual(['2026', '2028', '2030', '2032', '2034', '2036']);
    // a bigger budget takes the finer stride
    expect(yearTicks(360, 3, '2026-10-08', 8).map((t) => t.label)).toEqual(['2026', '2031', '2036', '2041', '2046', '2051', '2056']);
    for (const months of [5, 13, 50, 99, 250, 600]) {
      const ticks = yearTicks(months, sampleStep(months), '2026-10-08');
      expect(ticks.length).toBeLessThanOrEqual(6);
      for (let i = 1; i < ticks.length; i++) expect(ticks[i].index - ticks[i - 1].index).toBeGreaterThanOrEqual(2);
    }
  });

  it('month ticks for a short horizon: every 1, 2, 3 or 6 months from the start, as yyyy-mm', () => {
    expect(monthTicks(5, 1, '2026-10-08').map((t) => t.label)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    expect(monthTicks(9, 1, '2026-10-08')).toEqual([
      { index: 0, label: '2026-10' },
      { index: 2, label: '2026-12' },
      { index: 4, label: '2027-02' },
      { index: 6, label: '2027-04' },
      { index: 8, label: '2027-06' },
    ]);
    expect(monthTicks(23, 1, '2026-10-08').map((t) => t.index)).toEqual([0, 6, 12, 18]);
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
