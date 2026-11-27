import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { EntityName, RecurringRow } from '@/db/types';
import { periodAt, planId } from '@/domain/planning';
import { DELETED_FIELD } from '@/sync/merge';

// #692: "catch up" was kept on the recurring cost for one release (5.32.0). The choice is the plan's own, so it moves to
// the plan subjects of that cost and leaves the cost. Every change is stamped right behind the value it replaces: each
// device writes the same one, a choice made on a subject since then wins, and a second pass changes nothing.

type CostWithPace = RecurringRow & { planPace?: string | null };

const localToday = (): string => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
};

/** a plan started over before 5.33.0 carries no `fresh`: the current period's is marked, so it begins with nothing as
 *  its owner expected when they started over. A plan that was removed and stands again was started over by hand — a
 *  carry-over never revives one. Stamped right behind the removal it follows from, so every device writes the same. */
export async function markRestartedPlans(store: StorageBackend, repo: Repo, today = localToday()): Promise<number> {
  let marked = 0;
  for (const space of await store.allRows('space')) {
    if (space.deleted !== 0 || !space.kind) continue;
    const period = periodAt({ periodType: space.periodType ?? 'month', periodDay: space.periodDay ?? 1 }, today);
    const plan = await store.get('plan', planId(space.id, 'actual', period.start));
    const removedAt = plan?.fieldVersions?.[DELETED_FIELD];
    if (!plan || plan.deleted !== 0 || !removedAt || plan.fieldVersions.fresh !== undefined) continue;
    marked += await repo.upsertStamped(space.id, [{ entity: 'plan', entityId: plan.id, fields: { fresh: 1 }, hlc: `${removedAt}~` }]);
  }
  return marked;
}

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
