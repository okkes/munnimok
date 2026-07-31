import { describe, expect, it } from 'vitest';
import type { AccountRow, DebtRow } from '@/db/types';
import {
  debtProgress,
  debtRemainingCents,
  debtsOverview,
  estimatePaymentPlan,
  monthlyPaymentCents,
  paymentsPerYear,
  projectPayoff,
} from './debts';

const account = (partial: Partial<AccountRow>): AccountRow =>
  ({
    id: Math.random().toString(36).slice(2),
    spaceId: 's1',
    name: 'acct',
    type: 'loan',
    source: 'manual',
    currency: 'EUR',
    balanceCents: 0,
    deleted: 0,
    fieldVersions: {},
    ...partial,
  }) as AccountRow;

const debt = (partial: Partial<DebtRow>): DebtRow =>
  ({ id: 'd', spaceId: 's1', name: 'd', originalCents: 100_000, deleted: 0, fieldVersions: {}, ...partial }) as DebtRow;

describe('debts math', () => {
  it('remaining prefers the linked liability balance (negative → owed)', () => {
    const acct = account({ id: 'loan1', balanceCents: -35_000 });
    const byId = new Map([[acct.id, acct]]);
    expect(debtRemainingCents(debt({ accountId: 'loan1' }), byId)).toBe(35_000);
    expect(debtRemainingCents(debt({ remainingCents: 12_000 }), new Map())).toBe(12_000);
    expect(debtRemainingCents(debt({}), new Map())).toBe(100_000);
    expect(debtProgress(debt({}), 35_000)).toBeCloseTo(0.65);
  });

  it('an original-less loan (arc 3) still answers: remaining 0-fallback, progress unknown', () => {
    expect(debtRemainingCents(debt({ originalCents: undefined }), new Map())).toBe(0);
    expect(debtProgress(debt({ originalCents: undefined }), 35_000)).toBe(0);
  });

  it('projects payoff with monthly compounding; impossible payments return null', () => {
    // 10k at 12% APR, 500/mo → ~22 months, some interest paid
    const projection = projectPayoff(1_000_000, 50_000, 12, '2026-07-09');
    expect(projection).not.toBeNull();
    expect(projection!.months).toBeGreaterThan(20);
    expect(projection!.totalInterestCents).toBeGreaterThan(0);
    expect(projection!.endMonth > '2028-01').toBe(true);

    expect(projectPayoff(1_000_000, 5_000, 12, '2026-07-09')).toBeNull(); // payment < interest
    expect(projectPayoff(1_000_000, undefined, 12, '2026-07-09')).toBeNull();
    // zero interest is a plain division
    expect(projectPayoff(120_000, 10_000, undefined, '2026-07-09')!.months).toBe(12);
  });

  it('the projection follows the payment cadence (arc 3)', () => {
    // €120 owed, €10 payments, no interest: 12 payments — weekly they
    // fit in ~3 months, monthly they take a year
    const weekly = projectPayoff(120_000, 10_000, undefined, '2026-07-09', paymentsPerYear('week'));
    expect(weekly!.months).toBe(3);
    expect(weekly!.endMonth).toBe('2026-10');
    const yearly = projectPayoff(120_000, 10_000, undefined, '2026-07-09', paymentsPerYear('year'));
    expect(yearly!.months).toBe(144);
    // an every-2-months cadence halves the per-year count
    expect(paymentsPerYear('month', 2)).toBe(6);
    // a weekly payer is charged less total interest than a monthly one
    const wk = projectPayoff(1_000_000, 12_000, 12, '2026-07-09', paymentsPerYear('week'));
    const mo = projectPayoff(1_000_000, 52_000, 12, '2026-07-09', paymentsPerYear('month'));
    expect(wk!.totalInterestCents).toBeLessThan(mo!.totalInterestCents);
  });

  it('estimates the plan from ≥3 payments by medians; mirrored pairs collapse', () => {
    // monthly-ish history with one outlier gap and one odd amount
    const est = estimatePaymentPlan([
      { date: '2026-01-15', amountCents: -25_000 },
      { date: '2026-02-15', amountCents: -25_000 },
      { date: '2026-03-17', amountCents: -26_000 },
      { date: '2026-04-15', amountCents: -25_000 },
    ]);
    expect(est).not.toBeNull();
    expect(est!.paymentCents).toBe(25_000);
    expect(est!.everyDays).toBeGreaterThanOrEqual(29);
    expect(est!.everyDays).toBeLessThanOrEqual(31);
    expect(Math.round(est!.perYear)).toBe(12);

    // both legs of a mirror write are ONE payment event
    const paired = estimatePaymentPlan([
      { date: '2026-01-15', amountCents: -25_000 },
      { date: '2026-01-15', amountCents: 25_000 },
      { date: '2026-02-15', amountCents: -25_000 },
      { date: '2026-02-15', amountCents: 25_000 },
      { date: '2026-03-15', amountCents: -25_000 },
      { date: '2026-03-15', amountCents: 25_000 },
    ]);
    expect(paired!.paymentCents).toBe(25_000);
    expect(paired!.everyDays).toBeGreaterThanOrEqual(28);

    // too thin to claim anything
    expect(estimatePaymentPlan([{ date: '2026-01-15', amountCents: -25_000 }, { date: '2026-02-15', amountCents: -25_000 }])).toBeNull();
    expect(estimatePaymentPlan([])).toBeNull();
  });

  it('overview sums owed + cadence-normalized monthly payments of active debts', () => {
    const overview = debtsOverview(
      [debt({ remainingCents: 5000, paymentCents: 100 }), debt({ remainingCents: 7000, paymentCents: 200, archived: 1 })],
      new Map(),
    );
    expect(overview).toEqual({ totalOwedCents: 5000, totalMonthlyCents: 100 });
    // €100 weekly ≈ €433 a month on the overview
    expect(monthlyPaymentCents(debt({ paymentCents: 10_000, paymentEvery: 'week' }))).toBe(43_333);
    expect(monthlyPaymentCents(debt({ paymentCents: 120_000, paymentEvery: 'year' }))).toBe(10_000);
    expect(monthlyPaymentCents(debt({}))).toBe(0);
  });
});
