import type { AccountRow, DebtRow } from '@/db/types';

/** Debt math (approved debts design) — all pure, interest informational. */

/** remaining owed: the linked liability account's balance is the truth
 *  (stored negative → owed is its magnitude); manual debts carry their
 *  own remaining, defaulting to the original size */
export function debtRemainingCents(debt: DebtRow, accountsById: ReadonlyMap<string, AccountRow>): number {
  if (debt.accountId) {
    const account = accountsById.get(debt.accountId);
    if (account) return Math.max(0, -account.balanceCents);
  }
  return Math.max(0, debt.remainingCents ?? debt.originalCents);
}

/** 0..1 paid-off share */
export function debtProgress(debt: DebtRow, remainingCents: number): number {
  if (debt.originalCents <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingCents / debt.originalCents));
}

export interface PayoffProjection {
  months: number;
  /** yyyy-mm of the final payment */
  endMonth: string;
  totalInterestCents: number;
}

const MAX_MONTHS = 600; // 50 years — beyond that the payment isn't working

/**
 * Amortization walk: fixed monthly payment against monthly compounding
 * of the (informational) APR. Null when there's no payment or the
 * payment doesn't beat the interest.
 */
export function projectPayoff(
  remainingCents: number,
  paymentCents: number | undefined,
  interestPctYear: number | undefined,
  today: string,
): PayoffProjection | null {
  if (!paymentCents || paymentCents <= 0 || remainingCents <= 0) return null;
  const monthlyRate = (interestPctYear ?? 0) / 100 / 12;
  let balance = remainingCents;
  let totalInterest = 0;
  let months = 0;
  while (balance > 0 && months < MAX_MONTHS) {
    const interest = Math.round(balance * monthlyRate);
    if (paymentCents <= interest) return null; // never pays off
    totalInterest += interest;
    balance = balance + interest - paymentCents;
    months++;
  }
  if (balance > 0) return null;
  const [y, m] = today.split('-').map(Number);
  const end = new Date(y, m - 1 + months, 1);
  return {
    months,
    endMonth: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}`,
    totalInterestCents: totalInterest,
  };
}

export interface DebtsOverview {
  totalOwedCents: number;
  totalMonthlyCents: number;
}

export function debtsOverview(debts: readonly DebtRow[], accountsById: ReadonlyMap<string, AccountRow>): DebtsOverview {
  const active = debts.filter((d) => d.deleted === 0 && d.archived !== 1);
  return {
    totalOwedCents: active.reduce((sum, d) => sum + debtRemainingCents(d, accountsById), 0),
    totalMonthlyCents: active.reduce((sum, d) => sum + (d.paymentCents ?? 0), 0),
  };
}
