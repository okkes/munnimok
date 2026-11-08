import { describe, expect, it } from 'vitest';
import { accountTail, counterPlanOf, planFits } from './counterPlan';

describe('#556 what a counterparty account is regularly paid', () => {
  it('a loan answers with its own payment plan, rhythm included', () => {
    expect(counterPlanOf({ id: 'l1', paymentCents: 5520, paymentEvery: 'month' }, [])).toEqual({ cents: 5520, every: 'month', everyN: undefined });
    // no rhythm stored: monthly, the loan default
    expect(counterPlanOf({ id: 'l1', paymentCents: 5520 }, [])?.every).toBe('month');
  });

  it('any other account answers with an active recurring cost paid into it', () => {
    const recs = [
      { linkedAccountId: 'pot', active: 0 as const, amountCents: 9999, every: 'month' as const },
      { linkedAccountId: 'pot', active: 1 as const, amountCents: 20000, every: 'week' as const, everyN: 2 },
    ];
    expect(counterPlanOf({ id: 'pot' }, recs)).toEqual({ cents: 20000, every: 'week', everyN: 2 });
    expect(counterPlanOf({ id: 'other' }, recs)).toBeUndefined();
  });

  it('a payment fits a plan within 2 % — at least half a euro', () => {
    const plan = { cents: 5520, every: 'month' as const };
    expect(planFits(plan, -5520)).toBe(true);
    expect(planFits(plan, -5569)).toBe(true);
    expect(planFits(plan, -6324)).toBe(false);
    expect(planFits({ cents: 1000, every: 'month' }, -1049)).toBe(true);
  });

  it('the number\'s last four tell two look-alike accounts apart', () => {
    expect(accountTail({ iban: 'NL45 INGB 0705 0019 03' })).toBe('1903');
    expect(accountTail({ maskedNumber: '5248********7201' })).toBe('7201');
    expect(accountTail({})).toBeUndefined();
  });
});
