import type { AccountRow, RecurringEvery, RecurringRow } from '@/db/types';

export interface CounterPlan {
  cents: number;
  every: RecurringEvery;
  everyN?: number;
}

// #556: several "ING Loan" rows read alike, so the payment each takes tells them apart; a loan's own plan answers first,
// any other account answers with an active recurring paid into it (#274)
export function counterPlanOf(
  account: Pick<AccountRow, 'id' | 'paymentCents' | 'paymentEvery' | 'paymentEveryN'>,
  recurrings: readonly Pick<RecurringRow, 'linkedAccountId' | 'active' | 'amountCents' | 'every' | 'everyN'>[],
): CounterPlan | undefined {
  if (account.paymentCents && account.paymentCents > 0) {
    return { cents: account.paymentCents, every: account.paymentEvery ?? 'month', everyN: account.paymentEveryN };
  }
  const rec = recurrings.find((r) => r.active === 1 && r.linkedAccountId === account.id && r.amountCents > 0);
  return rec ? { cents: rec.amountCents, every: rec.every, everyN: rec.everyN } : undefined;
}

/** the plan is this payment: the amount within 2 % (at least half a euro) */
export const planFits = (plan: CounterPlan, amountCents: number): boolean =>
  Math.abs(Math.abs(amountCents) - plan.cents) <= Math.max(50, Math.round(plan.cents * 0.02));

/** the last four characters of an account's number — "ING Loan" twice is two numbers */
export function accountTail(account: Pick<AccountRow, 'iban' | 'maskedNumber'>): string | undefined {
  const digits = (account.iban ?? account.maskedNumber ?? '').replaceAll(/[^0-9A-Za-z]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : undefined;
}
