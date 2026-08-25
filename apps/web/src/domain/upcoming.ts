import type { AccountRow, RecurringRow } from '@/db/types';
import { nextDueDate } from './recurring';
import { isDebtTracked, nextDebtPaymentDate } from './debts';

/**
 * #334 (user): the home "Coming up" block and its see-all landing must
 * tell the SAME story — one row per active recurring cost and one per
 * tracked loan payment plan due inside the window, soonest first. The
 * shared computation lives here so the block and /upcoming cannot drift.
 */

export interface UpcomingRecurring<R extends RecurringRow = RecurringRow> {
  rec: R;
  nextDue: string;
}

export interface UpcomingLoan<A extends AccountRow = AccountRow> {
  loan: A;
  nextDue: string;
}

/** active recurring costs due in [today..horizon], soonest first
 *  (inactive rows drop out via nextDueDate's own active gate) */
export function upcomingRecurrings<R extends RecurringRow>(recurrings: R[], today: string, horizon: string): UpcomingRecurring<R>[] {
  return recurrings
    .filter((rec) => rec.deleted === 0)
    .map((rec) => ({ rec, nextDue: nextDueDate(rec, today) }))
    .filter((u): u is UpcomingRecurring<R> => u.nextDue !== null && u.nextDue <= horizon)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}

/** tracked loan payment plans due in the window — archived accounts and
 *  dormant default pots stay out, matching the home block (#266) */
export function upcomingLoanPayments<A extends AccountRow>(accounts: A[], today: string, horizon: string): UpcomingLoan<A>[] {
  return accounts
    .filter((a) => a.deleted === 0 && a.archived !== 1 && !a.defaultFor && isDebtTracked(a))
    .map((loan) => ({ loan, nextDue: nextDebtPaymentDate(loan, today) }))
    .filter((u): u is UpcomingLoan<A> => u.nextDue !== null && u.nextDue <= horizon)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue));
}
