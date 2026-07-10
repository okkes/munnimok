import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import { useSpaceTransactions } from './transactions';
import { localToday } from './recurring';
import { budgetStatus, sortByUrgency } from '@/domain/budgets';
import type { BudgetStatus } from '@/domain/budgets';
import { useCategories } from '@/features/categories/useCategories';
import type { BudgetRow } from '@/db/types';

/** the active space's budgets, alphabetical */
export function useBudgets(): BudgetRow[] | undefined {
  const { db, spaceId } = useData();
  return useLiveQuery(async () => {
    const rows = await db.budgets.filter((b) => b.deleted === 0 && b.spaceId === spaceId).toArray();
    rows.sort((a, b) => a.name.localeCompare(b.name));
    return rows;
  }, [db, spaceId]);
}

/** live per-budget numbers for the current cycle, most urgent first */
export function useBudgetStatuses(): BudgetStatus[] | undefined {
  const budgets = useBudgets();
  const txs = useSpaceTransactions();
  const cats = useCategories();
  return useMemo(() => {
    if (!budgets || !txs) return undefined;
    const today = localToday();
    return sortByUrgency(budgets.filter((b) => b.active === 1).map((b) => budgetStatus(b, txs, cats, today)));
  }, [budgets, txs, cats]);
}

export interface BudgetOps {
  save: (id: string | null, fields: Partial<BudgetRow>) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

export function useBudgetOps(): BudgetOps {
  const { repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('budget', spaceId, rowId, fields);
      return rowId;
    },
    remove: (id) => repo.remove('budget', spaceId, id),
  };
}
