import type { AccountRow, AccountType, RecurringRow, SpaceRow, SpendSetAside, TxView } from '@/db/types';
import { debtPaymentCadence, isDebtTracked } from './debts';
import { periodAt, periodLengthDays } from './planning';
import type { Period } from './periods';
import { occurrencesBetween } from './recurring';
import { txSliceViews } from './txSlices';

/**
 * Safe to spend (#541, user 2026-10-22): what the period still lets you
 * spend freely. The balances of the accounts you spend from, minus the hard
 * facts — every recurring cost and loan payment still due before the period
 * ends — minus the plan's set-asides you chose to keep untouched (the money
 * given to goals, events…). A plan that gives every euro a job no longer
 * zeroes the number by itself: its set-asides count only once picked.
 */

/** the types money is spent from — a credit card pays like a checking account (#532) */
export const SPEND_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['checking', 'cash', 'savings', 'credit']);

/** nothing picked yet: the money in hand */
const DEFAULT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['checking', 'cash']);

/** the planner's set-asides on offer — recurring costs and debts are the hard facts already */
export const SET_ASIDE_KINDS: readonly SpendSetAside[] = ['goals', 'events', 'expenses', 'budgets', 'ahead'];

type SpendAccount = Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived'>;
type SpendSpace = Pick<SpaceRow, 'spendAccountIds'> | null | undefined;

/** an account a person may pick: live, not archived, a type money is spent from */
export const isSpendCandidate = (account: SpendAccount): boolean =>
  account.deleted === 0 && account.archived !== 1 && SPEND_TYPES.has(account.type);

/** the picked list, or — nothing picked — every checking and cash account */
export function isSpendAccount(account: SpendAccount, space: SpendSpace): boolean {
  if (!isSpendCandidate(account)) return false;
  const picked = space?.spendAccountIds;
  return picked ? picked.includes(account.id) : DEFAULT_TYPES.has(account.type);
}

/** a pick that equals the default stores nothing, so an account added later joins by itself */
export function isDefaultSpendPick(ids: ReadonlySet<string>, accounts: readonly SpendAccount[]): boolean {
  const defaults = accounts.filter((a) => isSpendCandidate(a) && DEFAULT_TYPES.has(a.type));
  return ids.size === defaults.length && defaults.every((a) => ids.has(a.id));
}

export interface SpendDue {
  kind: 'recurring' | 'loan';
  /** the recurring cost's id, or the loan's account id */
  id: string;
  name: string;
  /** the occurrences still open before the period ends, soonest first */
  dates: string[];
  cents: number;
}

const addTo = (map: Map<string, number>, key: string, cents: number) => map.set(key, (map.get(key) ?? 0) + cents);

/** what went out this period towards each recurring cost and each account it was linked to */
function paidInPeriod(txs: readonly TxView[], period: Period): { byRecurring: Map<string, number>; byAccount: Map<string, number> } {
  const byRecurring = new Map<string, number>();
  const byAccount = new Map<string, number>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.date < period.start || tx.date > period.end) continue;
    for (const slice of txSliceViews(tx)) {
      if (slice.amountCents >= 0) continue;
      if (slice.recurringId) addTo(byRecurring, slice.recurringId, -slice.amountCents);
      if (slice.linkedAccountId) addTo(byAccount, slice.linkedAccountId, -slice.amountCents);
    }
  }
  return { byRecurring, byAccount };
}

/**
 * What is still open of a cost falling due on `dates` this period: what the
 * period expects minus what it paid — never more than the occurrences still
 * ahead, so a payment that went by without a link does not count twice. An
 * early payment covers the nearest occurrence first.
 */
function stillOpen(dates: readonly string[], amountCents: number, paidCents: number, today: string): Pick<SpendDue, 'dates' | 'cents'> | null {
  if (amountCents <= 0) return null;
  const ahead = dates.filter((date) => date >= today);
  const cents = Math.min(ahead.length * amountCents, Math.max(0, dates.length * amountCents - paidCents));
  if (cents <= 0) return null;
  return { dates: ahead.slice(ahead.length - Math.ceil(cents / amountCents)), cents };
}

/** every live loan with a payment plan, the ones still due this period among them (a loan among the picked accounts is none) */
function loanDues(
  accounts: readonly AccountRow[],
  spendIds: ReadonlySet<string>,
  paidByAccount: ReadonlyMap<string, number>,
  period: Period,
  today: string,
): { dues: SpendDue[]; loanIds: Set<string> } {
  const dues: SpendDue[] = [];
  const loanIds = new Set<string>();
  for (const loan of accounts) {
    if (loan.deleted !== 0 || loan.archived === 1 || loan.defaultFor || !isDebtTracked(loan)) continue;
    const cadence = debtPaymentCadence(loan);
    if (!cadence) continue;
    loanIds.add(loan.id);
    if (spendIds.has(loan.id)) continue;
    const open = stillOpen(occurrencesBetween(cadence, period.start, period.end), Math.abs(loan.paymentCents ?? 0), paidByAccount.get(loan.id) ?? 0, today);
    if (open) dues.push({ kind: 'loan', id: loan.id, name: loan.name, ...open });
  }
  return { dues, loanIds };
}

/** the active recurring costs still due this period, but for a transfer to one of the `noDueIds` accounts */
function recurringDues(
  recurrings: readonly RecurringRow[],
  noDueIds: ReadonlySet<string>,
  paidByRecurring: ReadonlyMap<string, number>,
  period: Period,
  today: string,
): SpendDue[] {
  const dues: SpendDue[] = [];
  for (const rec of recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1) continue;
    if (rec.linkedAccountId && noDueIds.has(rec.linkedAccountId)) continue;
    const open = stillOpen(occurrencesBetween(rec, period.start, period.end), Math.abs(rec.amountCents), paidByRecurring.get(rec.id) ?? 0, today);
    if (open) dues.push({ kind: 'recurring', id: rec.id, name: rec.name, ...open });
  }
  return dues;
}

/**
 * The hard facts: every recurring cost and loan payment still due before the
 * period ends. A loan among the picked accounts is no due — its balance
 * already counts, so paying it moves money between them — and neither is a
 * recurring transfer to one of them. A recurring cost linked to a loan with a
 * payment plan is that loan's payment, listed once, as the loan.
 */
export function spendDues(input: {
  accounts: readonly AccountRow[];
  recurrings: readonly RecurringRow[];
  txs: readonly TxView[];
  spendIds: ReadonlySet<string>;
  period: Period;
  today: string;
}): SpendDue[] {
  const { period, today, spendIds } = input;
  const paid = paidInPeriod(input.txs, period);
  const loans = loanDues(input.accounts, spendIds, paid.byAccount, period, today);
  const noDueIds = new Set([...spendIds, ...loans.loanIds]);
  const dues = [...loans.dues, ...recurringDues(input.recurrings, noDueIds, paid.byRecurring, period, today)];
  return dues.sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || a.name.localeCompare(b.name));
}

export interface SpendSetAsideLine {
  kind: SpendSetAside;
  /** what the plan holds for it now */
  cents: number;
  /** the person chose to keep it untouched */
  picked: boolean;
}

export interface SafeToSpend {
  period: Period;
  /** the days left in the period, today counted */
  days: number;
  /** the accounts spent from, balances in the ledger currency */
  accounts: AccountRow[];
  balanceCents: number;
  dues: SpendDue[];
  dueCents: number;
  /** every set-aside on offer while the space plans; none without a plan */
  setAsides: SpendSetAsideLine[];
  /** the picked set-asides together */
  setAsideCents: number;
  cents: number;
  perDayCents: number;
}

/** null when the space has no account money is spent from at all — nothing honest to say */
export function safeToSpend(input: {
  /** the space's accounts, balances already in the ledger currency */
  accounts: readonly AccountRow[];
  space: Pick<SpaceRow, 'periodType' | 'periodDay' | 'spendAccountIds' | 'spendSetAsides'>;
  recurrings: readonly RecurringRow[];
  txs: readonly TxView[];
  /** what the plan holds per set-aside; null while the space plans nothing */
  held: Readonly<Record<SpendSetAside, number>> | null;
  today: string;
}): SafeToSpend | null {
  if (!input.accounts.some(isSpendCandidate)) return null;
  const period = periodAt(input.space, input.today);
  const accounts = input.accounts.filter((a) => isSpendAccount(a, input.space));
  const balanceCents = accounts.reduce((sum, a) => sum + a.balanceCents, 0);
  const dues = spendDues({ ...input, spendIds: new Set(accounts.map((a) => a.id)), period });
  const dueCents = dues.reduce((sum, due) => sum + due.cents, 0);
  const chosen = new Set(input.space.spendSetAsides ?? []);
  const held = input.held;
  const setAsides = held ? SET_ASIDE_KINDS.map((kind) => ({ kind, cents: Math.max(0, held[kind]), picked: chosen.has(kind) })) : [];
  const setAsideCents = setAsides.reduce((sum, line) => sum + (line.picked ? line.cents : 0), 0);
  const cents = balanceCents - dueCents - setAsideCents;
  const days = periodLengthDays({ start: input.today, end: period.end });
  return { period, days, accounts, balanceCents, dues, dueCents, setAsides, setAsideCents, cents, perDayCents: Math.floor(cents / days) };
}
