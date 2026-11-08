import { describe, expect, it } from 'vitest';
import type { AccountRow } from '@/db/types';
import {
  FOCUS_SHARE,
  STRATEGIES,
  axisFraction,
  axisTicks,
  chartAxis,
  compareStrategies,
  extraForDebtBy,
  extraForPlanBy,
  extraLadder,
  hasTail,
  monthAfter,
  monthTicks,
  monthsUntil,
  orderDebts,
  raisedPayment,
  sampleWalk,
  simulateBaseline,
  simulateDebtAlone,
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

describe('one debt on its own (user 2026-10-09)', () => {
  it('walks the debt alone: with no extra it is the baseline walk of that debt, the extra shortens it and cuts its interest', () => {
    const alone = simulateDebtAlone(car);
    // the baseline's car walk is the same walk, padded with zeros until the last of the three is gone
    const inBaseline = simulateBaseline(three).balancesByDebt.car;
    expect(inBaseline.slice(0, alone.balances.length)).toEqual(alone.balances);
    expect(inBaseline.slice(alone.balances.length).every((v) => v === 0)).toBe(true);
    expect(alone.months).toBe(simulateBaseline(three).debts.find((d) => d.id === 'car')!.paidOffMonth);
    expect(alone.monthlyCents).toBe(25_000);
    expect(alone.stuck).toBe(false);
    expect(alone.paidCents).toBe(1_000_000 + alone.interestCents);
    const more = simulateDebtAlone(car, 20_000);
    expect(more.months!).toBeLessThan(alone.months!);
    expect(more.interestCents).toBeLessThan(alone.interestCents);
    expect(more.monthlyCents).toBe(45_000);
    // month 1: interest, then the minimum and the extra
    expect(more.balances[1]).toBe(1_000_000 + Math.round((1_000_000 * 5) / 100 / 12) - 45_000);
  });

  it('nothing from the other debts reaches it: inside the plan a freed minimum shortens the car, alone it stays what its own payment makes it', () => {
    const plan = simulatePlan(three, { strategy: 'avalanche', extraByDebtCents: { family: 200_000 } });
    const carInPlan = plan.debts.find((d) => d.id === 'car')!;
    expect(carInPlan.paidOffMonth!).toBeLessThan(simulateDebtAlone(car).months!);
    // the alone walk is a function of the one debt and its own extra, nothing else
    expect(simulateDebtAlone(car, 0)).toEqual(simulateDebtAlone(car));
    expect(simulateDebtAlone(car, 5_000).balances).not.toEqual(simulateDebtAlone(car).balances);
    const cardAlone = simulateDebtAlone(card).balances;
    expect(simulateBaseline(three).balancesByDebt.card.slice(0, cardAlone.length)).toEqual(cardAlone);
  });

  it('a payment under its interest is stuck alone, and not with enough extra; the horizon caps the walk', () => {
    const trap = debt({ id: 'trap', balanceCents: 1_000_000, aprPct: 24, minMonthlyCents: 10_000 });
    expect(simulateDebtAlone(trap)).toMatchObject({ months: null, stuck: true });
    expect(simulateDebtAlone(trap, 30_000)).toMatchObject({ stuck: false });
    expect(simulateDebtAlone(trap, 30_000).months).not.toBeNull();
    expect(simulateDebtAlone(debt({ id: 'slow', balanceCents: 10_000_000, aprPct: 0, minMonthlyCents: 1_000 }), 0, 24).balances).toHaveLength(25);
    expect(simulateDebtAlone(debt({ id: 'gone', balanceCents: 0 }))).toMatchObject({ months: 0, stuck: false, balances: [0] });
  });
});

describe('the rollover switch (user 2026-10-09)', () => {
  it('off, with no extra, the plan is the baseline whatever the order; the extra still reaches the first debt of the order', () => {
    const baseline = simulateBaseline(three);
    for (const s of STRATEGIES) {
      const off = simulatePlan(three, { strategy: s, rollover: false });
      expect(off.balances).toEqual(baseline.balances);
      expect(off.months).toBe(baseline.months);
      expect(off.totalInterestCents).toBe(baseline.totalInterestCents);
    }
    // the family loan's 5 000 stops with it: the card's walk is the baseline's
    const off = simulatePlan(three, { strategy: 'avalanche', rollover: false });
    expect(off.balancesByDebt.card).toEqual(baseline.balancesByDebt.card);
    // with the switch on the family's freed minimum shortens the card
    const on = simulatePlan(three, { strategy: 'avalanche', rollover: true });
    expect(on.debts.find((d) => d.id === 'card')!.paidOffMonth!).toBeLessThan(off.debts.find((d) => d.id === 'card')!.paidOffMonth!);
    // an extra with the rollover off: avalanche aims it at the card
    const extra = simulatePlan(three, { strategy: 'avalanche', rollover: false, extraMonthlyCents: 10_000 });
    expect(extra.balancesByDebt.card[1]).toBe(baseline.balancesByDebt.card[1] - 10_000);
    expect(extra.balancesByDebt.car[1]).toBe(baseline.balancesByDebt.car[1]);
  });

  it('the comparison and the ladder carry the switch', () => {
    const baseline = simulateBaseline(three);
    const compared = compareStrategies(three, { rollover: false });
    for (const s of STRATEGIES) expect(compared[s].months).toBe(baseline.months);
    const [step] = extraLadder(three, { strategy: 'avalanche', rollover: false }, [0]);
    expect(step.months).toBe(baseline.months);
    expect(step.totalInterestCents).toBe(baseline.totalInterestCents);
  });
});

describe('applying an extra to the loan (user 2026-10-09)', () => {
  it('a monthly loan adds the extra as it is; a weekly one gets a twelfth of fifty-two; every two weeks half of that; none stored becomes the extra', () => {
    expect(raisedPayment({ paymentCents: 15_000, paymentEvery: 'month' }, 20_000)).toEqual({ paymentCents: 35_000, extraCents: 20_000, perYear: 12 });
    expect(raisedPayment({ paymentCents: 15_000 }, 20_000)).toEqual({ paymentCents: 35_000, extraCents: 20_000, perYear: 12 });
    expect(raisedPayment({ paymentCents: 5_000, paymentEvery: 'week' }, 5_000)).toEqual({ paymentCents: 6_154, extraCents: 1_154, perYear: 52 });
    expect(raisedPayment({ paymentCents: 5_000, paymentEvery: 'week', paymentEveryN: 2 }, 5_000)).toEqual({ paymentCents: 7_308, extraCents: 2_308, perYear: 26 });
    expect(raisedPayment({ paymentCents: 120_000, paymentEvery: 'year' }, 5_000)).toEqual({ paymentCents: 180_000, extraCents: 60_000, perYear: 1 });
    expect(raisedPayment({}, 2_500)).toEqual({ paymentCents: 2_500, extraCents: 2_500, perYear: 12 });
    expect(raisedPayment({ paymentCents: 1_000 }, -5)).toEqual({ paymentCents: 1_000, extraCents: 0, perYear: 12 });
  });
});

describe('the chart axis (#513)', () => {
  it('the minimums line always ends on the chart: close ends share the plan’s even scale, far ones follow on a compressed tail', () => {
    // a 20-month plan against a 65-month minimum: one even scale to the minimum's end
    expect(chartAxis(20, 65)).toEqual({ focusMonths: 65, totalMonths: 65 });
    // an 11-month plan against thirty years: the plan's 17 months, then the tail to the end
    expect(chartAxis(11, 366)).toEqual({ focusMonths: 17, totalMonths: 366 });
    expect(hasTail(chartAxis(11, 366))).toBe(true);
    // the plan IS the minimums: six months of room past the shared end
    expect(chartAxis(40, 40)).toEqual({ focusMonths: 46, totalMonths: 46 });
    expect(chartAxis(0, 0)).toEqual({ focusMonths: 6, totalMonths: 6 });
  });

  it('a month’s place across the axis: even up to the focus, the tail sharing what is left', () => {
    const even = chartAxis(20, 65);
    expect(axisFraction(even, 0)).toBe(0);
    expect(axisFraction(even, 32.5)).toBe(0.5);
    expect(axisFraction(even, 99)).toBe(1);
    const tailed = chartAxis(11, 366);
    expect(axisFraction(tailed, 17)).toBeCloseTo(FOCUS_SHARE, 10);
    expect(axisFraction(tailed, 8.5)).toBeCloseTo(FOCUS_SHARE / 2, 10);
    expect(axisFraction(tailed, 366)).toBe(1);
    expect(axisFraction(tailed, 17 + (366 - 17) / 2)).toBeCloseTo(FOCUS_SHARE + (1 - FOCUS_SHARE) / 2, 10);
  });

  it('a walk that pays off stops where it lands; one that never does holds to the axis end; the tail samples coarser', () => {
    const axis = chartAxis(3, 3);
    expect(sampleWalk([100, 50, 20, 0], true, axis)).toEqual([
      { month: 0, value: 100 },
      { month: 1, value: 50 },
      { month: 2, value: 20 },
      { month: 3, value: 0 },
    ]);
    const stuck = sampleWalk([100, 100, 100], false, axis);
    expect(stuck.at(-1)).toEqual({ month: axis.totalMonths, value: 100 });
    expect(sampleWalk([], true, axis)).toEqual([]);
    const long = Array.from({ length: 367 }, (_, i) => 366 - i);
    const tailed = chartAxis(11, 366);
    const points = sampleWalk(long, true, tailed);
    expect(points.at(-1)).toEqual({ month: 366, value: 0 });
    expect(points.length).toBeLessThanOrEqual(125);
    // every month on the even scale, then wider steps — the break point itself sampled
    expect(points.slice(0, 18).map((p) => p.month)).toEqual(Array.from({ length: 18 }, (_, i) => i));
    expect(points[18].month - points[17].month).toBeGreaterThan(1);
  });

  it('year ticks stand where their year begins (#513), on round years — every 1, 2, 5 or 10 — and the start names this year when it stands clear', () => {
    // from October 2026, January 2027 is three months out
    expect(yearTicks(24, '2026-10-08')).toEqual([
      { month: 0, label: '2026' },
      { month: 3, label: '2027' },
      { month: 15, label: '2028' },
    ]);
    // a June payoff (month 20) sits right of its own year's mark, never left of it
    const ticks = yearTicks(24, '2026-10-08');
    expect(ticks.filter((t) => t.month <= 20).at(-1)?.label).toBe('2028');
    // thirty years: every fifth year, the start too close to 2030 to be named
    const thirty = yearTicks(360, '2026-10-08');
    expect(thirty.map((t) => t.label)).toEqual(['2030', '2035', '2040', '2045', '2050', '2055']);
    expect(thirty.map((t) => t.month)).toEqual([39, 99, 159, 219, 279, 339]);
    // six Januaries fit at one per year; ten years take the even ones
    expect(yearTicks(72, '2026-10-08').map((t) => t.label)).toEqual(['2027', '2028', '2029', '2030', '2031', '2032']);
    expect(yearTicks(120, '2026-10-08').map((t) => t.label)).toEqual(['2026', '2028', '2030', '2032', '2034', '2036']);
    // January itself is a year's own start
    expect(yearTicks(30, '2027-01-15').map((t) => t.label)).toEqual(['2027', '2028', '2029']);
    for (const months of [5, 13, 50, 99, 250, 600]) {
      const marks = yearTicks(months, '2026-10-08');
      expect(marks.length).toBeLessThanOrEqual(7);
      for (let i = 1; i < marks.length; i++) expect(marks[i].month - marks[i - 1].month).toBeGreaterThanOrEqual(Math.ceil(months / 8));
    }
  });

  it('month ticks for a short horizon: every 1, 2, 3 or 6 months from the start, as yyyy-mm', () => {
    expect(monthTicks(5, '2026-10-08').map((t) => t.label)).toEqual(['2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03']);
    expect(monthTicks(9, '2026-10-08')).toEqual([
      { month: 0, label: '2026-10' },
      { month: 2, label: '2026-12' },
      { month: 4, label: '2027-02' },
      { month: 6, label: '2027-04' },
      { month: 8, label: '2027-06' },
    ]);
    expect(monthTicks(23, '2026-10-08').map((t) => t.month)).toEqual([0, 6, 12, 18]);
  });

  it('axis ticks: the even scale’s marks, then the tail’s middle year (a long tail) and its end year', () => {
    expect(axisTicks(chartAxis(20, 65), '2026-10-08').map((t) => t.label)).toEqual(['2027', '2028', '2029', '2030', '2031', '2032']);
    const tailed = axisTicks(chartAxis(11, 366), '2026-10-08');
    // four month marks at most on the even 72%, then the January nearest the tail's middle, and its end, 2057
    expect(tailed.map((t) => t.label)).toEqual(['2026-10', '2027-04', '2027-10', '2043', '2057']);
    expect(tailed[3].month % 12).toBe(3);
    expect(tailed.at(-1)?.month).toBe(366);
    // a short tail names its end only
    expect(axisTicks(chartAxis(11, 60), '2026-10-08').map((t) => t.label).at(-1)).toBe('2031');
    expect(axisTicks(chartAxis(11, 60), '2026-10-08').filter((t) => t.label.length === 4)).toHaveLength(1);
  });
});

describe('an end date instead of an amount (#514)', () => {
  it('months until a picked month, from this one', () => {
    expect(monthsUntil('2026-10-08', '2026-10')).toBe(0);
    expect(monthsUntil('2026-10-08', '2027-06')).toBe(8);
    expect(monthsUntil('2026-10-08', '2025-12')).toBe(-10);
  });

  it('one debt: the smallest whole-euro extra that pays it off by then — none when its own payment already does, null for a month already here', () => {
    const minimum = simulateDebtAlone(car).months!;
    expect(extraForDebtBy(car, minimum)).toBe(0);
    expect(extraForDebtBy(car, minimum + 12)).toBe(0);
    expect(extraForDebtBy(car, 0)).toBeNull();
    const extra = extraForDebtBy(car, 24)!;
    expect(extra % 100).toBe(0);
    expect(simulateDebtAlone(car, extra).months!).toBeLessThanOrEqual(24);
    // a euro less misses the month
    expect(simulateDebtAlone(car, extra - 100).months!).toBeGreaterThan(24);
    // next month: everything at once (and a month's interest)
    expect(simulateDebtAlone(car, extraForDebtBy(car, 1)!).months).toBe(1);
    // a payment under its interest still gets there with enough extra
    const trap = debt({ id: 'trap', balanceCents: 1_000_000, aprPct: 24, minMonthlyCents: 10_000 });
    expect(simulateDebtAlone(trap, extraForDebtBy(trap, 36)!).months!).toBeLessThanOrEqual(36);
  });

  it('the whole plan: the extra per month on top of its order, its per-debt extras and its one-off', () => {
    const options = { strategy: 'snowball' as const, lumpSumCents: 50_000, extraByDebtCents: { car: 5_000 } };
    const extra = extraForPlanBy(three, options, 30)!;
    expect(simulatePlan(three, { ...options, extraMonthlyCents: extra }).months!).toBeLessThanOrEqual(30);
    expect(simulatePlan(three, { ...options, extraMonthlyCents: extra - 100 }).months!).toBeGreaterThan(30);
    expect(extraForPlanBy(three, options, 600)).toBe(0);
    expect(extraForPlanBy(three, options, -1)).toBeNull();
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
