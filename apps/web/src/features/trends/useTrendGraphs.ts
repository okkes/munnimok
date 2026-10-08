import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import type { SpaceRow } from '@/db/types';

/** one custom graph as the space row stores it */
export type TrendGraph = NonNullable<SpaceRow['trendGraphs']>[number];

export interface TrendGraphDraft {
  /** absent = a new graph */
  id?: string;
  name: string;
  catIds: string[];
}

export interface TrendGraphOps {
  /** create or update; resolves with the graph's id */
  save: (draft: TrendGraphDraft) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

/** the list with one graph replaced in place, or appended when it is new */
function withGraph(current: readonly TrendGraph[], row: TrendGraph): TrendGraph[] {
  if (!current.some((graph) => graph.id === row.id)) return [...current, row];
  return current.map((graph) => (graph.id === row.id ? row : graph));
}

/**
 * The custom graphs live on the space row (user 2026-10-08) — one list
 * field, written whole through the Repo so it syncs like homeBlocks.
 * Every change leaves a line in the space's history.
 */
export function useTrendGraphOps(space: SpaceRow | undefined): TrendGraphOps {
  const { store, repo, spaceId } = useData();
  const current = space?.trendGraphs ?? [];
  const write = (next: TrendGraph[]) => repo.upsert('space', spaceId, spaceId, { trendGraphs: next });
  return {
    save: async (draft) => {
      const id = draft.id ?? repo.newId();
      const row: TrendGraph = { id, name: draft.name.trim(), catIds: [...draft.catIds] };
      const exists = current.some((graph) => graph.id === id);
      await write(withGraph(current, row));
      void logActivity(store, repo, spaceId, exists ? 'trendGraphEdit' : 'trendGraphAdd', row.name);
      return id;
    },
    remove: async (id) => {
      const gone = current.find((graph) => graph.id === id);
      await write(current.filter((graph) => graph.id !== id));
      void logActivity(store, repo, spaceId, 'trendGraphRemove', gone?.name);
    },
  };
}
