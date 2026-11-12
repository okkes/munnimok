import { useMemo } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { cashOutSet } from '@/domain/goals';
import { localToday } from './recurring';
import { logRowActivity } from './activity';
import type { GoalRow, TxView } from '@/db/types';

/**
 * Goals with their allocation DERIVED from the contribution rows —
 * concurrent funding on two devices then converges by addition instead
 * of losing one bump to LWW. The stored allocatedCents is written as a
 * display snapshot but never trusted.
 */
export function useGoals(): GoalRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const [allGoals, allContributions] = await Promise.all([
        store.bySpace('goal', spaceId),
        store.bySpace('goalContribution', spaceId),
      ]);
      const rows = allGoals.filter((g) => g.deleted === 0);
      const contributions = allContributions.filter((c) => c.deleted === 0);
      const allocated = new Map<string, number>();
      for (const contribution of contributions) {
        allocated.set(contribution.goalId, (allocated.get(contribution.goalId) ?? 0) + contribution.amountCents);
      }
      const goals = rows.map((g) => ({ ...g, allocatedCents: allocated.get(g.id) ?? 0 }));
      goals.sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0) || a.name.localeCompare(b.name));
      return goals;
    },
    [spaceId],
    undefined,
    `goals:${spaceId}`, // #361: remount cache
  );
}

/** #455: the rows goals cashed out, both legs of a pair — the overview keeps them out of the saving */
export function useCashOutSet(txs: readonly TxView[] | undefined): ReadonlySet<string> {
  const goals = useGoals();
  return useMemo(() => cashOutSet(goals ?? [], txs ?? []), [goals, txs]);
}

export interface GoalOps {
  save: (id: string | null, fields: Partial<GoalRow>) => Promise<string>;
  remove: (id: string) => Promise<void>;
  /** + funds, − withdraws back to unallocated */
  contribute: (goalId: string, amountCents: number, note?: string) => Promise<void>;
  /**
   * #455: the goal was spent — the rows that paid for it leave the
   * saving of their period and the goal is archived; archived goals hold
   * no allocation, so whatever it held beyond them is back in the pool.
   * `purchaseTxIds` names what the money bought.
   */
  cashOut: (goal: GoalRow, txIds: readonly string[], purchaseTxIds?: readonly string[]) => Promise<void>;
  /** a cashed-out goal names (or renames) what its money bought; the money that paid for it stays as picked */
  namePurchases: (goal: GoalRow, purchaseTxIds: readonly string[]) => Promise<void>;
  /** the goal comes back as it was; its rows count as saving again */
  undoCashOut: (goal: GoalRow) => Promise<void>;
}

export function useGoalOps(): GoalOps {
  const { store, repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('goal', spaceId, rowId, fields);
      void logRowActivity(store, repo, spaceId, 'goal', rowId, id ? 'goalEdit' : 'goalAdd', fields.name);
      return rowId;
    },
    remove: async (id) => {
      await logRowActivity(store, repo, spaceId, 'goal', id, 'goalRemove');
      await repo.remove('goal', spaceId, id);
    },
    contribute: async (goalId, amountCents, note) => {
      await repo.upsert('goalContribution', spaceId, repo.newId(), {
        goalId,
        amountCents,
        date: localToday(),
        note,
      });
      // display snapshot only — the derived sum is the truth
      const contributions = (await store.bySpace('goalContribution', spaceId)).filter(
        (c) => c.deleted === 0 && c.goalId === goalId,
      );
      const total = contributions.reduce((sum, c) => sum + c.amountCents, 0);
      await repo.upsert('goal', spaceId, goalId, { allocatedCents: total });
      void logRowActivity(store, repo, spaceId, 'goal', goalId, 'goalEdit');
    },
    cashOut: async (goal, txIds, purchaseTxIds = []) => {
      const cashOut = { date: localToday(), txIds: [...txIds], ...(purchaseTxIds.length > 0 ? { purchaseTxIds: [...purchaseTxIds] } : {}) };
      await repo.upsert('goal', spaceId, goal.id, { archived: 1, cashOut });
      void logRowActivity(store, repo, spaceId, 'goal', goal.id, 'goalCashOut', goal.name);
    },
    namePurchases: async (goal, purchaseTxIds) => {
      if (!goal.cashOut) return;
      await repo.upsert('goal', spaceId, goal.id, { cashOut: { date: goal.cashOut.date, txIds: [...goal.cashOut.txIds], purchaseTxIds: [...purchaseTxIds] } });
      void logRowActivity(store, repo, spaceId, 'goal', goal.id, 'goalPurchase', goal.name);
    },
    undoCashOut: async (goal) => {
      await repo.upsert('goal', spaceId, goal.id, { archived: 0, cashOut: null });
      void logRowActivity(store, repo, spaceId, 'goal', goal.id, 'goalCashOutUndo', goal.name);
    },
  };
}
