import { describe, expect, it } from 'vitest';
import type { AccountRow } from '@/db/types';
import { encodeHlc } from '@/sync/hlc';
import {
  debtsOverview,
  estimatePaymentPlan,
  hasNoFixedPayment,
  isDebtTracked,
  loanOverpaidCents,
  paidOffYear,
  loanProgress,
  loanRemainingCents,
  monthlyPaymentCents,
  nextDebtPaymentDate,
  overpayingSteps,
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

describe('loan math (v2: the account IS the debt)', () => {
  it('remaining is the balance magnitude; an overpaid card owes nothing', () => {
    expect(loanRemainingCents(account({ balanceCents: -35_000 }))).toBe(35_000);
    expect(loanRemainingCents(account({ balanceCents: 12_000 }))).toBe(0);
    expect(loanProgress(account({ originalCents: 100_000 }), 35_000)).toBeCloseTo(0.65);
  });

  it('#697: the year a loan was marked paid off is read from the clock of its archived field', () => {
    const stamp = (iso: string) => encodeHlc({ wallMs: new Date(iso).getTime(), counter: 0, deviceId: 'd1' });
    expect(paidOffYear(account({ archived: 1, fieldVersions: { archived: stamp('2025-06-15T12:00:00') } }))).toBe(2025);
    expect(paidOffYear(account({ archived: 1, fieldVersions: { archived: stamp('2026-11-26T12:00:00') } }))).toBe(2026);
    // reopened: its clock says when it was reopened, which is no payoff
    expect(paidOffYear(account({ archived: 0, fieldVersions: { archived: stamp('2025-06-15T12:00:00') } }))).toBeNull();
    expect(paidOffYear(account({ archived: 1 }))).toBeNull();
    expect(paidOffYear(account({}))).toBeNull();
  });

  it('#693: a loan whose balance stands above zero was paid back too much; a card holding a credit was not', () => {
    expect(loanOverpaidCents(account({ balanceCents: 70_000 }))).toBe(70_000);
    expect(loanOverpaidCents(account({ type: 'mortgage', balanceCents: 5 }))).toBe(5);
    expect(loanOverpaidCents(account({ balanceCents: -35_000 }))).toBe(0);
    expect(loanOverpaidCents(account({ balanceCents: 0 }))).toBe(0);
    expect(loanOverpaidCents(account({ type: 'credit', balanceCents: 12_000 }))).toBe(0);
    // a bank that states no balance for the account says nothing of the kind
    expect(loanOverpaidCents(account({ balanceCents: undefined as never }))).toBe(0);
  });

  it('#693: the payments that went past zero, each with the part that was too much — read back from the balance', () => {
    // borrowed 800, then paid back 750 twice on one day: the loan stands 700 above zero, and one payment carries all of it
    const steps = [
      { id: 'borrow', date: '2026-11-12', deltaCents: -80_000 },
      { id: 'pay-a', date: '2026-11-24', deltaCents: 75_000 },
      { id: 'pay-b', date: '2026-11-24', deltaCents: 75_000 },
    ];
    expect([...overpayingSteps(70_000, steps)]).toEqual([['pay-b', 70_000]]);
    // two payments past zero: the newest whole, the one before it in part
    expect([...overpayingSteps(100_000, [...steps, { id: 'pay-c', date: '2026-11-25', deltaCents: 30_000 }])]).toEqual([
      ['pay-c', 30_000],
      ['pay-b', 70_000],
    ]);
    // borrowing more after the excess takes it back: nothing is too much any more
    expect(overpayingSteps(-10_000, steps).size).toBe(0);
    // a draw is never the payment that was too much, and the walk goes on past it
    expect([...overpayingSteps(20_000, [{ id: 'pay', date: '2026-11-01', deltaCents: 50_000 }, { id: 'draw', date: '2026-11-02', deltaCents: -10_000 }])]).toEqual([['pay', 30_000]]);
  });

  it('#683: a payment of 0 is a loan paid back whenever — nothing due, nothing per month; an empty payment is no such answer', () => {
    const whenever = account({ paymentCents: 0, balanceCents: -100_000 });
    expect(hasNoFixedPayment(whenever)).toBe(true);
    expect(hasNoFixedPayment(account({}))).toBe(false);
    expect(hasNoFixedPayment(account({ paymentCents: null as never }))).toBe(false);
    expect(hasNoFixedPayment(account({ paymentCents: 5_000 }))).toBe(false);
    expect(nextDebtPaymentDate({ ...whenever, paymentDay: 10 }, '2026-11-24')).toBeNull();
    expect(monthlyPaymentCents(whenever)).toBe(0);
    expect(projectPayoff(100_000, whenever.paymentCents, 0, '2026-11-24')).toBeNull();
  });

  it('an original-less loan still answers: progress unknown reads 0', () => {
    expect(loanProgress(account({}), 35_000)).toBe(0);
  });

  it('membership: loans by nature, cards by story or toggle', () => {
    expect(isDebtTracked(account({ type: 'loan' }))).toBe(true);
    expect(isDebtTracked(account({ type: 'mortgage' }))).toBe(true);
    expect(isDebtTracked(account({ type: 'checking' }))).toBe(false);
    expect(isDebtTracked(account({ type: 'credit' }))).toBe(false);
    expect(isDebtTracked(account({ type: 'credit', interestPctYear: 14 }))).toBe(true);
    expect(isDebtTracked(account({ type: 'credit', paymentCents: 5_000 }))).toBe(true);
    expect(isDebtTracked(account({ type: 'credit', trackAsDebt: 1 }))).toBe(true);
    expect(isDebtTracked(account({ type: 'loan', trackAsDebt: 0 }))).toBe(false);
    expect(isDebtTracked(account({ type: 'credit', interestPctYear: 14, trackAsDebt: 0 }))).toBe(false);
  });

  it('membership: a default account on its way out that holds nothing is no debt — one holding a debt, or kept as the person’s own, is', () => {
    expect(isDebtTracked(account({ type: 'loan', defaultFor: 'debtPayment' }))).toBe(false);
    expect(isDebtTracked(account({ type: 'loan', defaultFor: 'debtPayment', balanceCents: -5_000 }))).toBe(true);
    expect(isDebtTracked(account({ type: 'loan', defaultFor: null as never }))).toBe(true);
  });

  it('projects payoff with monthly compounding; impossible payments return null', () => {
    // 10k at 12% APR, 500/mo → ~22 months, some interest paid
    const projection = projectPayoff(1_000_000, 50_000, 12, '2026-07-09');
    expect(projection).not.toBeNull();
    expect(projection!.months).toBeGreaterThan(20);
    expect(projection!.totalInterestCents).toBeGreaterThan(0);
    expect(projection!.endMonth > '2028-01').toBe(true);

    expect(projectPayoff(1_000_000, 5_000, 12, '2026-07-09')).toBeNull();
    expect(projectPayoff(1_000_000, undefined, 12, '2026-07-09')).toBeNull();
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
    expect(paymentsPerYear('month', 2)).toBe(6);
    const wk = projectPayoff(1_000_000, 12_000, 12, '2026-07-09', paymentsPerYear('week'));
    const mo = projectPayoff(1_000_000, 52_000, 12, '2026-07-09', paymentsPerYear('month'));
    expect(wk!.totalInterestCents).toBeLessThan(mo!.totalInterestCents);
  });

  it('estimates the plan from ≥3 payments by medians; mirrored pairs collapse', () => {
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

    expect(estimatePaymentPlan([{ date: '2026-01-15', amountCents: -25_000 }, { date: '2026-02-15', amountCents: -25_000 }])).toBeNull();
    expect(estimatePaymentPlan([])).toBeNull();
  });

  it('overview sums owed + cadence-normalized monthly payments of active tracked loans', () => {
    const overview = debtsOverview([
      account({ balanceCents: -5000, paymentCents: 100 }),
      account({ balanceCents: -7000, paymentCents: 200, archived: 1 }),
      account({ type: 'credit', balanceCents: -9000 }),
    ]);
    expect(overview).toEqual({ totalOwedCents: 5000, totalMonthlyCents: 100 });
    expect(monthlyPaymentCents(account({ paymentCents: 10_000, paymentEvery: 'week' }))).toBe(43_333);
    expect(monthlyPaymentCents(account({ paymentCents: 120_000, paymentEvery: 'year' }))).toBe(10_000);
    expect(monthlyPaymentCents(account({}))).toBe(0);
  });
});
