import type { AccountRow, AccountType, RecurringRow, SpaceRow, SpendSetAside, TxView } from '@/db/types';
import { debtPaymentCadence, isDebtTracked } from './debts';
import { periodAt, periodLengthDays } from './planning';
import type { Period } from './periods';
import { addDays, cycleMonths, occurrencesBetween } from './recurring';
import { txSliceViews } from './txSlices';

// #541: the balances of the accounts spent from, minus the hard facts (recurring costs and loan payments due before
// the period ends), minus the plan's set-asides picked to stay untouched; unpicked set-asides do not zero the number

/** a credit card pays like a checking account (#532) */
export const SPEND_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['checking', 'cash', 'savings', 'credit']);

const DEFAULT_TYPES: ReadonlySet<AccountType> = new Set<AccountType>(['checking', 'cash']);

/** the planner's set-asides on offer — recurring costs and debts are the hard facts already */
export const SET_ASIDE_KINDS: readonly SpendSetAside[] = ['goals', 'events', 'expenses', 'budgets', 'ahead'];

type SpendAccount = Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived'>;
type SpendSpace = Pick<SpaceRow, 'spendAccountIds'> | null | undefined;

export const isSpendCandidate = (account: SpendAccount): boolean =>
  account.deleted === 0 && account.archived !== 1 && SPEND_TYPES.has(account.type);

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
  id: string;
  name: string;
  dates: string[];
  cents: number;
}

type Cadence = Pick<RecurringRow, 'every' | 'everyN' | 'dueDay' | 'dueMonth' | 'since' | 'until'>;

const DAY_MS = 86_400_000;
const daysApart = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

const addDay = (map: Map<string, string[]>, key: string, day: string) => {
  const days = map.get(key);
  if (days) days.push(day);
  else map.set(key, [day]);
};

// only a row's own links or its parts can point at a cost — the rest of the history is skipped unread
const mayPay = (tx: TxView): boolean => !!tx.recurringId || !!tx.linkedAccountId || !!tx.splits?.length;

function paidTowards(tx: TxView): { costs: Set<string>; accounts: Set<string> } {
  const costs = new Set<string>();
  const accounts = new Set<string>();
  for (const slice of txSliceViews(tx)) {
    if (slice.amountCents >= 0) continue;
    if (slice.recurringId) costs.add(slice.recurringId);
    if (slice.linkedAccountId) accounts.add(slice.linkedAccountId);
  }
  return { costs, accounts };
}

function paymentDays(txs: readonly TxView[], until: string): { byRecurring: Map<string, string[]>; byAccount: Map<string, string[]> } {
  const byRecurring = new Map<string, string[]>();
  const byAccount = new Map<string, string[]>();
  for (const tx of txs) {
    if (tx.deleted !== 0 || tx.date > until || !mayPay(tx)) continue;
    const { costs, accounts } = paidTowards(tx);
    for (const id of costs) addDay(byRecurring, id, tx.date);
    for (const id of accounts) addDay(byAccount, id, tx.date);
  }
  for (const days of [...byRecurring.values(), ...byAccount.values()]) days.sort((a, b) => a.localeCompare(b));
  return { byRecurring, byAccount };
}

// a payment pays the occurrence nearest its day, whatever period it books in and whatever it came to
// a past occurrence without a linked payment is not asked for again: an unlinked payment would count twice
function stillOpen(cadence: Cadence, amountCents: number, paidOn: readonly string[], period: Period, today: string): Pick<SpendDue, 'dates' | 'cents'> | null {
  if (amountCents <= 0) return null;
  const from = addDays(period.start, -Math.ceil(cycleMonths(cadence) * 31));
  const occurrences = occurrencesBetween(cadence, from, period.end);
  const covered = new Set<string>();
  for (const paid of paidOn) {
    if (paid < from) continue;
    let nearest: string | null = null;
    for (const date of occurrences) {
      // a tie goes to the later occurrence: paid ahead rather than paid late
      if (!covered.has(date) && (nearest === null || daysApart(paid, date) <= daysApart(paid, nearest))) nearest = date;
    }
    if (nearest) covered.add(nearest);
  }
  const dates = occurrences.filter((date) => date >= period.start && date >= today && !covered.has(date));
  return dates.length > 0 ? { dates, cents: dates.length * amountCents } : null;
}

function loanDues(
  accounts: readonly AccountRow[],
  spendIds: ReadonlySet<string>,
  paidByAccount: ReadonlyMap<string, readonly string[]>,
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
    const open = stillOpen(cadence, Math.abs(loan.paymentCents ?? 0), paidByAccount.get(loan.id) ?? [], period, today);
    if (open) dues.push({ kind: 'loan', id: loan.id, name: loan.name, ...open });
  }
  return { dues, loanIds };
}

function recurringDues(
  recurrings: readonly RecurringRow[],
  noDueIds: ReadonlySet<string>,
  paidByRecurring: ReadonlyMap<string, readonly string[]>,
  period: Period,
  today: string,
): SpendDue[] {
  const dues: SpendDue[] = [];
  for (const rec of recurrings) {
    if (rec.deleted !== 0 || rec.active !== 1) continue;
    if (rec.linkedAccountId && noDueIds.has(rec.linkedAccountId)) continue;
    const open = stillOpen(rec, Math.abs(rec.amountCents), paidByRecurring.get(rec.id) ?? [], period, today);
    if (open) dues.push({ kind: 'recurring', id: rec.id, name: rec.name, ...open });
  }
  return dues;
}

// a loan among the picked accounts is no due (its balance counts, paying it moves money between them), nor is a
// recurring transfer to one; a recurring cost linked to a loan with a plan is that loan's payment, listed once
export function spendDues(input: {
  accounts: readonly AccountRow[];
  recurrings: readonly RecurringRow[];
  txs: readonly TxView[];
  spendIds: ReadonlySet<string>;
  period: Period;
  today: string;
}): SpendDue[] {
  const { period, today, spendIds } = input;
  const paid = paymentDays(input.txs, period.end);
  const loans = loanDues(input.accounts, spendIds, paid.byAccount, period, today);
  const noDueIds = new Set([...spendIds, ...loans.loanIds]);
  const dues = [...loans.dues, ...recurringDues(input.recurrings, noDueIds, paid.byRecurring, period, today)];
  return dues.sort((a, b) => a.dates[0].localeCompare(b.dates[0]) || a.name.localeCompare(b.name));
}

export interface SpendSetAsideLine {
  kind: SpendSetAside;
  cents: number;
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
