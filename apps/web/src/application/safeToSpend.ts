import { useMemo } from 'react';
import { useData } from '@/app/data';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { SpendSetAside } from '@/db/types';
import { logActivity } from './activity';
import type { PlanningModel } from './planningModel';

/**
 * Safe to spend's settings (#541): which accounts it sums and which of the
 * plan's set-asides it keeps untouched — space facts under field LWW, so
 * everyone in a shared space reads the same number. The arithmetic lives
 * in domain/safeToSpend.
 */

/** what the plan holds per set-aside — null while the space plans neither this period nor ahead */
export function planHeld(model: PlanningModel | undefined): Record<SpendSetAside, number> | null {
  if (!model || (!model.plan && model.ahead.length === 0)) return null;
  const held = (segment: 'goals' | 'events' | 'expenses' | 'budgets') => model.heldBySegment.get(segment) ?? 0;
  return { goals: held('goals'), events: held('events'), expenses: held('expenses'), budgets: held('budgets'), ahead: model.aheadFundedCents };
}

export interface SafeToSpendOps {
  /** null = every checking and cash account again */
  setAccounts: (ids: readonly string[] | null) => Promise<void>;
  toggleSetAside: (kind: SpendSetAside) => Promise<void>;
}

export function buildSafeToSpendOps(store: StorageBackend, repo: Repo, spaceId: string): SafeToSpendOps {
  const logged = () => void logActivity(store, repo, spaceId, 'spendEdit');
  return {
    setAccounts: async (ids) => {
      await repo.upsert('space', spaceId, spaceId, { spendAccountIds: ids ? [...ids] : null });
      logged();
    },
    toggleSetAside: async (kind) => {
      // read the row fresh: two quick taps from a render-stale row would drop the first
      const current = (await store.get('space', spaceId))?.spendSetAsides ?? [];
      const next = current.includes(kind) ? current.filter((k) => k !== kind) : [...current, kind];
      await repo.upsert('space', spaceId, spaceId, { spendSetAsides: next });
      logged();
    },
  };
}

export function useSafeToSpendOps(): SafeToSpendOps {
  const { store, repo, spaceId } = useData();
  return useMemo(() => buildSafeToSpendOps(store, repo, spaceId), [store, repo, spaceId]);
}
