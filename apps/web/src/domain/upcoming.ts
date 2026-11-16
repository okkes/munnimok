import type { AccountRow, RecurringRow, SpaceRow } from '@/db/types';
import { addDays, nextDueDate } from './recurring';
import { periodHistory } from './periods';
import { isDebtTracked, nextDebtPaymentDate } from './debts';

// #334: the home "Coming up" block and /upcoming share this computation so they cannot drift

export interface UpcomingRecurring<R extends RecurringRow = RecurringRow> {
  rec: R;
  nextDue: string;
}

export interface UpcomingLoan<A extends AccountRow = AccountRow> {
  loan: A;
  nextDue: string;
}

export function upcomingRecurrings<R extends RecurringRow>(recurrings: R[], today: string, horizon: string): UpcomingRecurring<R>[] {
  return recurrings
    .filter((rec) => rec.deleted === 0)
    .map((rec) => ({ rec, nextDue: nextDueDate(rec, today) }))
    .filter((u): u is UpcomingRecurring<R> => u.nextDue !== null && u.nextDue <= horizon)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}

/** #334: the landing's window: the space's current period, at least the block's 7 days; shared so block and landing agree */
export function upcomingHorizon(space: Pick<SpaceRow, 'periodType' | 'periodDay'> | undefined, today: string): string {
  const period = periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, 1)[0];
  const week = addDays(today, 7);
  if (period.end > week) return period.end;
  return week;
}

/** #334: costs are outgoing: block and landing print plain unsigned amounts */
/** #347: whole days from today until the due date (0 = today) */
export const daysUntil = (iso: string, today: string): number =>
  Math.max(0, Math.round((Date.parse(iso) - Date.parse(today)) / 86_400_000));

export const upcomingRecAmountCents = (rec: Pick<RecurringRow, 'amountCents'>): number => Math.abs(rec.amountCents);
export const upcomingLoanAmountCents = (loan: Pick<AccountRow, 'paymentCents'>): number =>
  Math.abs(loan.paymentCents ?? 0);

/** tracked loan payment plans due in the window; archived accounts stay out, like the home block (#266) */
export function upcomingLoanPayments<A extends AccountRow>(accounts: A[], today: string, horizon: string): UpcomingLoan<A>[] {
  return accounts
    .filter((a) => a.deleted === 0 && a.archived !== 1 && isDebtTracked(a))
    .map((loan) => ({ loan, nextDue: nextDebtPaymentDate(loan, today) }))
    .filter((u): u is UpcomingLoan<A> => u.nextDue !== null && u.nextDue <= horizon)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}
