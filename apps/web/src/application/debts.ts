import { useMemo } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSpaceAccounts } from './transactions';
import { debtProgress, debtRemainingCents } from '@/domain/debts';
import type { DebtRow } from '@/db/types';

export interface DebtStatus {
  debt: DebtRow;
  remainingCents: number;
  progress: number;
}

/** the space's debts joined with their live remaining balances */
export function useDebtStatuses(): DebtStatus[] | undefined {
  const { store, spaceId } = useData();
  const accounts = useSpaceAccounts();
  const debts = useQuery(
    store,
    async () => {
      const rows = (await store.bySpace('debt', spaceId)).filter((d) => d.deleted === 0);
      rows.sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0) || a.name.localeCompare(b.name));
      return rows;
    },
    [spaceId],
  );
  return useMemo(() => {
    if (!debts || !accounts) return undefined;
    const accountsById = new Map(accounts.map((a) => [a.id, a]));
    return debts.map((debt) => {
      const remainingCents = debtRemainingCents(debt, accountsById);
      return { debt, remainingCents, progress: debtProgress(debt, remainingCents) };
    });
  }, [debts, accounts]);
}

export interface DebtOps {
  save: (id: string | null, fields: Partial<DebtRow>) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

export function useDebtOps(): DebtOps {
  const { repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('debt', spaceId, rowId, fields);
      return rowId;
    },
    remove: (id) => repo.remove('debt', spaceId, id),
  };
}
