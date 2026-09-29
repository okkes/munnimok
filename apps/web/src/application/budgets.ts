import { useMemo } from 'react';
import { useData } from '@/app/data';
import { logActivity, logRowActivity } from './activity';
import { useQuery } from '@/db/useQuery';
import { useSpaceTransactions } from './transactions';
import { localToday } from './recurring';
import { budgetOptsFor, budgetStatus, sortByUrgency } from '@/domain/budgets';
import type { BudgetStatus } from '@/domain/budgets';
import { useCategories } from '@/features/categories/useCategories';
import type { BudgetRow } from '@/db/types';

/** the active space's budgets, alphabetical */
export function useBudgets(): BudgetRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const rows = (await store.bySpace('budget', spaceId)).filter((b) => b.deleted === 0);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    },
    [spaceId],
    undefined,
    `budgets:${spaceId}`, // #361: remount cache
  );
}

/** live per-budget numbers for the current cycle, most urgent first */
export function useBudgetStatuses(): BudgetStatus[] | undefined {
  const { store, spaceId } = useData();
  const budgets = useBudgets();
  const txs = useSpaceTransactions();
  const cats = useCategories();
  // the space's first weekday and period shape steer the cycles (#369, #370)
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId], undefined, `space:${spaceId}`);
  return useMemo(() => {
    if (!budgets || !txs) return undefined;
    const today = localToday();
    const opts = budgetOptsFor(space);
    return sortByUrgency(budgets.filter((b) => b.active === 1).map((b) => budgetStatus(b, txs, cats, today, opts)));
  }, [budgets, txs, cats, space]);
}

export interface BudgetOps {
  save: (id: string | null, fields: Partial<BudgetRow>) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

export function useBudgetOps(): BudgetOps {
  const { store, repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('budget', spaceId, rowId, fields);
      if (id) void logRowActivity(store, repo, spaceId, 'budget', rowId, 'budgetEdit', fields.name);
      else void logActivity(store, repo, spaceId, 'budgetAdd', fields.name);
      return rowId;
    },
    remove: async (id) => {
      await logRowActivity(store, repo, spaceId, 'budget', id, 'budgetRemove');
      await repo.remove('budget', spaceId, id);
    },
  };
}
