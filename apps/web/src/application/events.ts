import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import type { EventRow } from '@/db/types';

/** the active space's events, active first then archived, newest range first */
export function useEvents(): EventRow[] | undefined {
  const { db, spaceId } = useData();
  return useLiveQuery(async () => {
    const rows = await db.events.filter((e) => e.deleted === 0 && e.spaceId === spaceId).toArray();
    rows.sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0) || (b.from ?? '').localeCompare(a.from ?? '') || a.name.localeCompare(b.name));
    return rows;
  }, [db, spaceId]);
}

export interface EventOps {
  save: (id: string | null, fields: Partial<EventRow>) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

export function useEventOps(): EventOps {
  const { repo, spaceId } = useData();
  return {
    save: async (id, fields) => {
      const rowId = id ?? repo.newId();
      await repo.upsert('event', spaceId, rowId, fields);
      return rowId;
    },
    remove: (id) => repo.remove('event', spaceId, id),
  };
}
