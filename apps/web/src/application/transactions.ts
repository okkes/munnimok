import { asSpaceAccount, historyTransactions, visibleAccounts, visibleTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceAccount, SpaceTx, TxTransformFields } from '@/db/joined';
import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';
import { txTitle } from '@/lib/text';
import { logActivity } from './activity';

export type { SpaceAccount, SpaceTx, TxTransformFields };

// screens never know whether a transaction is the space's own row or a feed row joined with this space's overlay (R1)

/** unsorted; one live read per space shared by all askers (#554); `active` false reads nothing */
export function useSpaceTransactions(active = true): SpaceTx[] | undefined {
  const { store, spaceId } = useData();
  // #361: remount cache — tab returns render the last rows instantly
  return useQuery(
    store,
    async () => (active ? visibleTransactions(store, spaceId) : undefined),
    [spaceId, active],
    undefined,
    active ? `spaceTx:${spaceId}` : undefined,
  );
}

export function useSpaceAccounts(): SpaceAccount[] | undefined {
  const { store, spaceId } = useData();
  // #361: remount cache — tab returns render the last rows instantly
  return useQuery(store, async () => visibleAccounts(store, spaceId), [spaceId], undefined, `spaceAccts:${spaceId}`);
}

/** #545: the name and type the space gave an attached account, never the global row's */
export function useSpaceAccount(accountId: string | undefined): SpaceAccount | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => (accountId ? asSpaceAccount(store, spaceId, await store.get('account', accountId)) : undefined),
    [spaceId, accountId],
  );
}

/** the full stored history, date gates lifted: recurring detection needs the pre-start tail */
export function useSpaceHistoryTransactions(): SpaceTx[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => historyTransactions(store, spaceId), [spaceId], undefined, `spaceHistTx:${spaceId}`);
}

export function useSpaceTransaction(txId: string): SpaceTx | undefined {
  return useSpaceTransactions()?.find((t) => t.id === txId);
}

// single write path for a space's opinion on a transaction: overlay for feed rows, in place for own rows
// `activity` = the history line ('txEdit' by default; null when the caller logs a richer one itself)
// auto-relinks call writeTxTransform directly, so machine writes never reach the history
export function useTxTransform(): (tx: SpaceTx, fields: TxTransformFields, activity?: string | null) => Promise<void> {
  const { store, repo, spaceId } = useData();
  return async (tx, fields, activity = 'txEdit') => {
    // the loan balance coupling rides inside writeTxTransform: every linkedAccountId writer shares it, not just this hook
    await writeTxTransform(repo, tx, fields);
    if (activity) void logActivity(store, repo, spaceId, activity, txTitle(tx));
  };
}
