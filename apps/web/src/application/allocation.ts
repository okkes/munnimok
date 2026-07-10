import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import { allocationId } from '@/domain/allocation';
import type { AllocationRow } from '@/db/types';

/** every allocation cell of the space (small table — periods × mains) */
export function useAllocations(): AllocationRow[] | undefined {
  const { db, spaceId } = useData();
  return useLiveQuery(
    () => db.allocations.filter((a) => a.deleted === 0 && a.spaceId === spaceId).toArray(),
    [db, spaceId],
  );
}

export interface AllocationOps {
  /** set a cell (deterministic id — concurrent edits LWW-converge) */
  assign: (periodStart: string, catId: string, assignedCents: number) => Promise<void>;
  /** envelope move: donor gives, receiver takes, same period */
  move: (periodStart: string, fromCatId: string, toCatId: string, cents: number, currentOf: (catId: string) => number) => Promise<void>;
}

export function useAllocationOps(): AllocationOps {
  const { repo, spaceId } = useData();
  const assign = async (periodStart: string, catId: string, assignedCents: number) => {
    await repo.upsert('allocation', spaceId, allocationId(spaceId, periodStart, catId), {
      periodStart,
      catId,
      assignedCents,
    });
  };
  return {
    assign,
    move: async (periodStart, fromCatId, toCatId, cents, currentOf) => {
      await assign(periodStart, fromCatId, currentOf(fromCatId) - cents);
      await assign(periodStart, toCatId, currentOf(toCatId) + cents);
    },
  };
}
