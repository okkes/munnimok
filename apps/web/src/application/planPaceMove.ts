import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { EntityName, RecurringRow } from '@/db/types';

// #692: "catch up" was kept on the recurring cost for one release (5.32.0). The choice is the plan's own, so it moves to
// the plan subjects of that cost and leaves the cost. Every change is stamped right behind the value it replaces: each
// device writes the same one, a choice made on a subject since then wins, and a second pass changes nothing.

type CostWithPace = RecurringRow & { planPace?: string | null };

export async function movePlanPaces(store: StorageBackend, repo: Repo): Promise<number> {
  const costs = (await store.allRows('recurring')) as CostWithPace[];
  let moved = 0;
  for (const cost of costs) {
    const stamp = cost.fieldVersions?.planPace;
    if (cost.deleted !== 0 || !stamp || (cost.planPace ?? null) === null) continue;
    const hlc = `${stamp}~`;
    const subjects =
      cost.planPace === 'catchUp'
        ? (await store.bySpace('planSubject', cost.spaceId)).filter((s) => s.deleted === 0 && s.segment === 'recurring' && s.sourceId === cost.id)
        : [];
    moved += await repo.upsertStamped(cost.spaceId, [
      ...subjects.map((subject) => ({ entity: 'planSubject' as EntityName, entityId: subject.id, fields: { pace: 'catchUp' }, hlc })),
      { entity: 'recurring' as EntityName, entityId: cost.id, fields: { planPace: null }, hlc },
    ]);
  }
  return moved;
}
