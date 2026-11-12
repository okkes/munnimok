import type { AccountRow, GoalRow, SpacePeriodType, SpaceRow, TxView } from '@/db/types';
import { mainCatOf } from './categories';
import { contributionCents } from './overview';
import { inPeriod, nextPeriod, periodHistory } from './periods';
import type { Period } from './periods';
import { addDays } from './recurring';
import { txSliceViews } from './txSlices';

/**
 * Goal math (approved goals design) — the savings BALANCE is the only
 * truth. Withdrawing from savings can push unallocated NEGATIVE; the
 * user rebalances by removing value from goals, the app only flags it.
 */

type PoolSpace = Pick<SpaceRow, 'goalPoolAccountIds'> | null | undefined;

/** #368: the savings accounts that feed the goals — manual, linked or
 *  imported alike; the space's picked list narrows them, no list = all */
export function poolAccounts<A extends Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived'>>(accounts: readonly A[], space: PoolSpace): A[] {
  const picked = space?.goalPoolAccountIds;
  return accounts.filter((a) => a.deleted === 0 && a.type === 'savings' && a.archived !== 1 && (!picked || picked.includes(a.id)));
}

/** the space's saved total: the pool's balances */
export function savingsTotalCents(accounts: readonly AccountRow[], space?: PoolSpace): number {
  return poolAccounts(accounts, space).reduce((sum, a) => sum + a.balanceCents, 0);
}

export interface GoalOverview {
  savedCents: number;
  allocatedCents: number;
  /** may be negative — that's the rebalance signal */
  unallocatedCents: number;
}

export function goalOverview(goals: readonly GoalRow[], accounts: readonly AccountRow[], space?: PoolSpace): GoalOverview {
  const savedCents = savingsTotalCents(accounts, space);
  const allocatedCents = goals
    .filter((g) => g.deleted === 0 && g.archived !== 1)
    .reduce((sum, g) => sum + g.allocatedCents, 0);
  return { savedCents, allocatedCents, unallocatedCents: savedCents - allocatedCents };
}

/** whole months from `today` until the goal's deadline (min 1); null undated */
export function monthsLeft(goal: Pick<GoalRow, 'targetDate'>, today: string): number | null {
  if (!goal.targetDate) return null;
  const [ty, tm] = goal.targetDate.split('-').map(Number);
  const [ny, nm] = today.split('-').map(Number);
  return Math.max(1, (ty - ny) * 12 + (tm - nm));
}

/** the rhythm a pace is counted in: the space's own period; monthly from the 1st while the space is not known yet */
export type PaceSpace = Pick<SpaceRow, 'periodType' | 'periodDay'> | null | undefined;

const parseLocal = (iso: string): Date => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

/**
 * The space's periods from today's until the one holding the deadline,
 * both counted (user 2026-10-04): a goal due next period is two chances
 * to put money aside - this period and the next - however the calendar
 * months fall around them. A whole-month count said one, and asked for
 * the lot at once. null undated.
 */
export function periodsLeft(space: PaceSpace, targetDate: string | null | undefined, today: string): number | null {
  if (!targetDate) return null;
  const type = space?.periodType ?? 'month';
  const day = space?.periodDay ?? 1;
  let period = periodHistory(type, day, 1, parseLocal(today))[0];
  let count = 1;
  while (period.end < targetDate && count < 1200) {
    period = nextPeriod(type, day, parseLocal(period.end));
    count += 1;
  }
  return count;
}

/** cents per period needed to reach the target by its date; 0 when reached; null undated */
export function paceCentsPerPeriod(goal: GoalRow, space: PaceSpace, today: string): number | null {
  const periods = periodsLeft(space, goal.targetDate, today);
  if (periods === null) return null;
  return Math.max(0, Math.ceil((goal.targetCents - goal.allocatedCents) / periods));
}

/** the word for one of the space's periods, as a copy key */
export function periodUnitKey(
  periodType: SpacePeriodType | undefined,
): 'goals.unitMonth' | 'goals.unitWeek' | 'goals.unitBiweekly' | 'goals.unitPeriod' {
  switch (periodType) {
    case 'week':
      return 'goals.unitWeek';
    case 'biweekly':
      return 'goals.unitBiweekly';
    case 'custom':
      return 'goals.unitPeriod';
    default:
      return 'goals.unitMonth';
  }
}

export const goalProgress = (goal: GoalRow): number =>
  goal.targetCents > 0 ? Math.min(1, goal.allocatedCents / goal.targetCents) : 0;

// ── #455: cash out ──────────────────────────────────────────────────────

type CashOutGoal = Pick<GoalRow, 'id' | 'deleted' | 'cashOut'>;

/**
 * Every row a goal cashed out, with the other leg of its pair: the
 * overview keeps them out of their period's saving — spending saved money
 * on what it was saved for is no setback.
 */
export function cashOutSet(goals: readonly CashOutGoal[], txs: readonly Pick<TxView, 'id' | 'transferPeerId'>[]): Set<string> {
  const marked = new Set(goals.filter((g) => g.deleted === 0).flatMap((g) => g.cashOut?.txIds ?? []));
  const out = new Set(marked);
  for (const tx of txs) {
    if (marked.has(tx.id) && tx.transferPeerId) out.add(tx.transferPeerId);
    if (tx.transferPeerId && marked.has(tx.transferPeerId)) out.add(tx.id);
  }
  return out;
}

/** the money that left savings in the rows a goal cashed out */
export function cashOutCents(goal: CashOutGoal, txs: readonly Pick<TxView, 'id' | 'amountCents' | 'deleted'>[]): number {
  const ids = new Set(goal.cashOut?.txIds ?? []);
  return txs.filter((tx) => tx.deleted === 0 && ids.has(tx.id)).reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
}

/** the goals cashed out inside a period, with what each took out of savings there — the overview names them instead of counting them */
export function goalCashOutsIn<G extends CashOutGoal>(
  goals: readonly G[],
  txs: readonly Pick<TxView, 'id' | 'amountCents' | 'deleted' | 'date'>[],
  period: Period,
): { goal: G; cents: number }[] {
  const out: { goal: G; cents: number }[] = [];
  for (const goal of goals) {
    if (goal.deleted !== 0 || !goal.cashOut) continue;
    const cents = cashOutCents(goal, txs.filter((tx) => inPeriod(tx.date, period)));
    if (cents > 0) out.push({ goal, cents });
  }
  return out.sort((a, b) => b.cents - a.cents);
}

/**
 * The unallocated savings once this goal is cashed out: an archived goal
 * holds nothing, so the pool gains what it held — the money that paid for
 * it already left the balance. Below zero means more left than the goal
 * and the free savings held together; the other goals keep theirs.
 */
export function poolAfterCashOut(
  goal: Pick<GoalRow, 'allocatedCents' | 'archived'>,
  goals: readonly GoalRow[],
  accounts: readonly AccountRow[],
  space?: PoolSpace,
): number {
  return goalOverview(goals, accounts, space).unallocatedCents + (goal.archived === 1 ? 0 : goal.allocatedCents);
}

/** every row a goal answers for, by the goal's id: what took its money out of savings and what that money bought */
export function goalPaidTxs(goals: readonly CashOutGoal[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const goal of goals) {
    if (goal.deleted !== 0 || !goal.cashOut) continue;
    for (const id of [...goal.cashOut.txIds, ...(goal.cashOut.purchaseTxIds ?? [])]) out.set(id, goal.id);
  }
  return out;
}

/** how far back the picker looks for the money that paid for a goal */
const CASH_OUT_DAYS = 400;

/**
 * The money that left the savings pool and paid for no goal yet — what
 * the cash-out picker offers, newest first: a pool account's outgoing
 * rows (fees aside), and a withdrawal filed on another account whose
 * savings leg is not in the pool's own list. One leg per pair; reserved
 * rows wait for their booked twin.
 */
export function cashOutCandidates<T extends TxView>(
  txs: readonly T[],
  accounts: readonly AccountRow[],
  space: PoolSpace,
  goals: readonly CashOutGoal[],
  today: string,
): T[] {
  const pool = new Set(poolAccounts(accounts, space).map((a) => a.id));
  const taken = cashOutSet(goals, txs);
  const since = addDays(today, -CASH_OUT_DAYS);
  const accountsById = new Map(accounts.map((a) => [a.id, a]));
  // a fee is the bank's, never a purchase
  const isFee = (tx: T) => txSliceViews(tx).some((v) => v.catId === 'savingFees');
  const live = txs.filter(
    (tx) => tx.deleted === 0 && tx.pending !== 1 && tx.date >= since && tx.date <= today && !taken.has(tx.id) && !isFee(tx),
  );
  const fromPool = live.filter((tx) => pool.has(tx.accountId) && tx.amountCents < 0);
  const poolIds = new Set(fromPool.map((tx) => tx.id));
  const pairedWithPool = (tx: T) =>
    (!!tx.transferPeerId && poolIds.has(tx.transferPeerId)) || fromPool.some((p) => p.transferPeerId === tx.id);
  // the other side of a withdrawal: never a savings account's own row (an unticked one is not the goals' money)
  const withdrawals = live.filter(
    (tx) =>
      accountsById.get(tx.accountId)?.type !== 'savings' &&
      txSliceViews(tx).some((v) => mainCatOf(v.catId) === 'saving') &&
      contributionCents('saving', tx, accountsById) < 0 &&
      !pairedWithPool(tx),
  );
  return [...fromPool, ...withdrawals].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/**
 * What the goal's money can have bought — the second pick of a cash-out,
 * newest first: booked spending outside the pool (a payment straight from
 * a pool account is in the first pick already) that no other goal names.
 * `forGoalId` keeps a cashed-out goal's own picks in the list.
 */
export function purchaseCandidates<T extends TxView>(
  txs: readonly T[],
  accounts: readonly AccountRow[],
  space: PoolSpace,
  goals: readonly CashOutGoal[],
  today: string,
  forGoalId?: string,
): T[] {
  const pool = new Set(poolAccounts(accounts, space).map((a) => a.id));
  const paid = goalPaidTxs(goals);
  const since = addDays(today, -CASH_OUT_DAYS);
  const free = (tx: T) => {
    const owner = paid.get(tx.id);
    return owner === undefined || owner === forGoalId;
  };
  return txs
    .filter(
      (tx) =>
        tx.deleted === 0 &&
        tx.pending !== 1 &&
        tx.date >= since &&
        tx.date <= today &&
        tx.amountCents < 0 &&
        !pool.has(tx.accountId) &&
        free(tx) &&
        txSliceViews(tx).some((v) => v.effType === 'expense' && !v.linkedAccountId),
    )
    .sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}
