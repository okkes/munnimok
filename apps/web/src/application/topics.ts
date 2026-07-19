import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import type { TopicRow } from '@/db/types';

/**
 * Allocation topics: user-defined groupings of MAIN categories ("Fun" =
 * entertainment + coffee + …) that structure the allocate screen.
 * Synced rows like any other space data.
 */
export function useTopics(): TopicRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const rows = (await store.bySpace('topic', spaceId)).filter((topic) => topic.deleted === 0);
      rows.sort((a, b) => a.name.localeCompare(b.name));
      return rows;
    },
    [spaceId],
  );
}

export function useTopicOps() {
  const { repo, spaceId } = useData();
  return {
    save: async (id: string | null, fields: { name: string; catIds: string[] }) =>
      repo.upsert('topic', spaceId, id ?? crypto.randomUUID(), fields),
    remove: async (id: string) => repo.remove('topic', spaceId, id),
  };
}
