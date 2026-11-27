import type { AccountRow, AccountType, RecurringEvery } from '@/db/types';
import { knownCents } from '@/lib/money';
import { decodeHlc } from '@/sync/hlc';
import { isRetiredDefault } from './defaultAccounts';
import { nextDueDate } from './recurring';

// loans v2: the liability ACCOUNT is the debt: its balance is the remaining truth and the story fields live on it;
// interest is informational

export const DEBT_ACCOUNT_TYPES: ReadonlySet<AccountType> = new Set(['loan', 'mortgage', 'credit']);

// membership: the explicit toggle wins; else loans and mortgages are in, a credit card only with a debt story
// (a card paid off monthly is an account with a balance, not a payoff journey)
export function isDebtTracked(
  account: Pick<AccountRow, 'type' | 'trackAsDebt' | 'interestPctYear' | 'originalCents' | 'paymentCents'> &
    Partial<Pick<AccountRow, 'defaultFor' | 'balanceCents'>>,
): boolean {
  if (!DEBT_ACCOUNT_TYPES.has(account.type)) return false;
  if (account.trackAsDebt !== undefined) return account.trackAsDebt === 1;
  // a retired default stays until a device that may write its space removed it: empty, it is nobody's loan
  if (isRetiredDefault(account) && (account.balanceCents ?? 0) === 0) return false;
  if (account.type !== 'credit') return true;
  return account.interestPctYear !== undefined || account.originalCents !== undefined || !!account.paymentCents;
}

// #683: 0 is the answer "paid back whenever"; an absent payment is an unanswered field that payments may estimate.
// Builds before #683 read 0 as absent, so the row's shape never changed.
export const hasNoFixedPayment = (loan: Pick<AccountRow, 'paymentCents'>): boolean => loan.paymentCents === 0;

/** remaining owed: the account's balance is the truth (stored negative →
 *  owed is its magnitude); an overpaid card sits at 0 owed */
export function loanRemainingCents(account: Pick<AccountRow, 'balanceCents'>): number {
  return Math.max(0, -account.balanceCents);
}

/** #697: the calendar year a loan was marked paid off, read from the clock its `archived` field was last written with —
 *  so no date is stored for it; null while it is open, or where the row carries no clock for the field */
export function paidOffYear(account: Pick<AccountRow, 'archived' | 'fieldVersions'>): number | null {
  const stamp = account.archived === 1 ? account.fieldVersions?.archived : undefined;
  if (!stamp) return null;
  const at = decodeHlc(stamp).wallMs;
  return Number.isFinite(at) ? new Date(at).getFullYear() : null;
}

/** #693: what was paid back beyond what the loan owed — its balance stands above zero. A card is left out: it may
 *  hold a credit (a refund, a payment ahead of the statement) and that is no mistake */
export function loanOverpaidCents(account: Pick<AccountRow, 'type' | 'balanceCents'>): number {
  return account.type === 'credit' ? 0 : Math.max(0, knownCents(account.balanceCents));
}

/** one movement of a loan's balance: above zero pays it down, below zero borrows more */
export interface LoanStep {
  id: string;
  date: string;
  deltaCents: number;
}

/** #693: the payments that went past zero, each with the part of it that was too much — read back from today's
 *  balance, newest first, until the loan stood at or below zero again */
export function overpayingSteps(balanceCents: number, steps: readonly LoanStep[]): Map<string, number> {
  const out = new Map<string, number>();
  let after = balanceCents;
  for (const step of [...steps].sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))) {
    if (after <= 0) break;
    if (step.deltaCents > 0) out.set(step.id, Math.min(after, step.deltaCents));
    after -= step.deltaCents;
  }
  return out;
}

/** 0..1 paid-off share — unknowable without the original size */
export function loanProgress(account: Pick<AccountRow, 'originalCents'>, remainingCents: number): number {
  const original = account.originalCents ?? 0;
  if (original <= 0) return 0;
  return Math.min(1, Math.max(0, 1 - remainingCents / original));
}

export function paymentsPerYear(every?: RecurringEvery, everyN?: number): number {
  const base = { week: 52, month: 12, year: 1 }[every ?? 'month'];
  return base / Math.max(1, everyN ?? 1);
}

export interface PayoffProjection {
  months: number;
  endMonth: string;
  totalInterestCents: number;
}

const MAX_STEPS = 2600; // 50 years of weekly payments — beyond that the payment isn't working

/** the period follows the loan's cadence; null when there is no payment or it does not beat the interest */
export function projectPayoff(
  remainingCents: number,
  paymentCents: number | undefined,
  interestPctYear: number | undefined,
  today: string,
  perYear = 12,
): PayoffProjection | null {
  if (!paymentCents || paymentCents <= 0 || remainingCents <= 0 || perYear <= 0) return null;
  const periodRate = (interestPctYear ?? 0) / 100 / perYear;
  let balance = remainingCents;
  let totalInterest = 0;
  let steps = 0;
  const maxSteps = Math.min(MAX_STEPS, Math.ceil(perYear * 50));
  while (balance > 0 && steps < maxSteps) {
    const interest = Math.round(balance * periodRate);
    if (paymentCents <= interest) return null;
    totalInterest += interest;
    balance = balance + interest - paymentCents;
    steps++;
  }
  if (balance > 0) return null;
  const months = Math.max(1, Math.round((steps * 12) / perYear));
  const [y, m] = today.split('-').map(Number);
  const end = new Date(y, m - 1 + months, 1);
  return {
    months,
    endMonth: `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}`,
    totalInterestCents: totalInterest,
  };
}

export interface PaymentEstimate {
  paymentCents: number;
  everyDays: number;
  perYear: number;
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

const DAY_MS = 86_400_000;

// "estimated from payments": never stored, used where the explicit frequency/value fields are empty;
// medians shrug off odd extras, a mirrored pair (both legs) collapses to one event; under 3 payments claim nothing
export function estimatePaymentPlan(payments: readonly { date: string; amountCents: number }[]): PaymentEstimate | null {
  const events = new Map<string, { date: string; abs: number }>();
  for (const p of payments) {
    const abs = Math.abs(p.amountCents);
    events.set(`${p.date}:${abs}`, { date: p.date, abs });
  }
  const unique = [...events.values()];
  const dates = [...new Set(unique.map((p) => p.date))].sort((a, b) => a.localeCompare(b));
  if (unique.length < 3 || dates.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push(Math.round((new Date(dates[i]).getTime() - new Date(dates[i - 1]).getTime()) / DAY_MS));
  }
  const everyDays = Math.max(1, median(gaps));
  return {
    paymentCents: median(unique.map((p) => p.abs)),
    everyDays,
    perYear: 365.25 / everyDays,
  };
}

/** #266: the loan plan in the recurring cadence shape, so it rides the
 *  same date math. Anchorless weekly plans have no derivable date → null. */
export function debtPaymentCadence(loan: Pick<AccountRow, 'paymentCents' | 'paymentEvery' | 'paymentEveryN' | 'paymentDay'>) {
  if (!loan.paymentCents || !loan.paymentDay) return null;
  if (loan.paymentEvery === 'week') return null;
  return {
    active: 1 as const,
    every: loan.paymentEvery ?? 'month',
    everyN: loan.paymentEveryN ?? 1,
    dueDay: loan.paymentDay,
    dueMonth: 1,
    since: '',
  };
}

export function nextDebtPaymentDate(
  loan: Pick<AccountRow, 'paymentCents' | 'paymentEvery' | 'paymentEveryN' | 'paymentDay'>,
  today: string,
): string | null {
  const cadence = debtPaymentCadence(loan);
  return cadence ? nextDueDate(cadence, today) : null;
}

export function monthlyPaymentCents(loan: Pick<AccountRow, 'paymentCents' | 'paymentEvery' | 'paymentEveryN'>): number {
  if (!loan.paymentCents) return 0;
  return Math.round((loan.paymentCents * paymentsPerYear(loan.paymentEvery, loan.paymentEveryN)) / 12);
}

export interface DebtsOverview {
  totalOwedCents: number;
  totalMonthlyCents: number;
}

export function debtsOverview(loans: readonly AccountRow[]): DebtsOverview {
  const active = loans.filter((a) => a.deleted === 0 && a.archived !== 1 && isDebtTracked(a));
  return {
    totalOwedCents: active.reduce((sum, a) => sum + loanRemainingCents(a), 0),
    totalMonthlyCents: active.reduce((sum, a) => sum + monthlyPaymentCents(a), 0),
  };
}
