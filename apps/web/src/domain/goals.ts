import type { AccountRow, GoalRow, SpacePeriodType, SpaceRow } from '@/db/types';
import { nextPeriod, periodHistory } from './periods';

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
export function periodsLeft(space: PaceSpace, targetDate: string | undefined, today: string): number | null {
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
