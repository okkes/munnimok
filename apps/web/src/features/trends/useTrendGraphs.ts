import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import type { SpaceRow } from '@/db/types';

/** one custom graph as the space row stores it */
export type TrendGraph = NonNullable<SpaceRow['trendGraphs']>[number];
/** #531: one custom balance line of the Cash flow tab */
export type CashflowGraph = NonNullable<SpaceRow['cashflowGraphs']>[number];

export interface TrendGraphDraft {
  /** absent = a new graph */
  id?: string;
  name: string;
  catIds: string[];
  /** #531: the accounts it reads; null = every account */
  accountIds: string[] | null;
  /** #455: what cashed-out goals bought stays out */
  skipGoalSpending?: boolean;
}

export interface CashflowGraphDraft {
  id?: string;
  name: string;
  accountIds: string[];
}

export interface GraphOps<D> {
  /** create or update; resolves with the graph's id */
  save: (draft: D) => Promise<string>;
  remove: (id: string) => Promise<void>;
}

/** the list with one graph replaced in place, or appended when it is new */
function withGraph<G extends { id: string }>(current: readonly G[], row: G): G[] {
  if (!current.some((graph) => graph.id === row.id)) return [...current, row];
  return current.map((graph) => (graph.id === row.id ? row : graph));
}

/**
 * The custom graphs live on the space row (user 2026-10-08) — one list
 * field, written whole through the Repo so it syncs like homeBlocks.
 * Every change leaves a line in the space's history.
 */
export function useTrendGraphOps(space: SpaceRow | undefined): GraphOps<TrendGraphDraft> {
  const { store, repo, spaceId } = useData();
  const current = space?.trendGraphs ?? [];
  const write = (next: TrendGraph[]) => repo.upsert('space', spaceId, spaceId, { trendGraphs: next });
  return {
    save: async (draft) => {
      const id = draft.id ?? repo.newId();
      // every account is the absence of a list — accounts added later join by themselves
      const row: TrendGraph = {
        id,
        name: draft.name.trim(),
        catIds: [...draft.catIds],
        ...(draft.accountIds ? { accountIds: [...draft.accountIds] } : {}),
        ...(draft.skipGoalSpending ? { skipGoalSpending: true } : {}),
      };
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

/** #531: the Cash flow tab's graphs, the same way — a list on the space row, a line in the history per change */
export function useCashflowGraphOps(space: SpaceRow | undefined): GraphOps<CashflowGraphDraft> {
  const { store, repo, spaceId } = useData();
  const current = space?.cashflowGraphs ?? [];
  const write = (next: CashflowGraph[]) => repo.upsert('space', spaceId, spaceId, { cashflowGraphs: next });
  return {
    save: async (draft) => {
      const id = draft.id ?? repo.newId();
      const row: CashflowGraph = { id, name: draft.name.trim(), accountIds: [...draft.accountIds] };
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
