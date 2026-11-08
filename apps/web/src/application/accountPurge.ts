import { txMetaId } from '@/domain/feedIds';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow } from '@/db/types';
import { releaseAccountReferences } from './accountRelease';

/**
 * #279: deleting a global account used to end at engine.purgeSpace,
 * which is FEED-space-keyed — so two kinds of remnants survived in
 * member spaces: txMeta overlays for the feed's transactions (invisible
 * but syncing forever) and the member space's OWN transaction rows on
 * the account (statement imports without a feed write those; they kept
 * rendering with a dangling account). Tombstone both via the repo —
 * tombstones sync to other devices, where a raw local delete would
 * resurrect on the next pull. Run BEFORE the engine purge, while the
 * feed's transaction ids are still readable.
 */
export async function purgeAccountRemnants(
  store: StorageBackend,
  repo: Repo,
  accountId: string,
  feedSpaceId: string,
): Promise<void> {
  // include tombstoned raws: their overlays are junk all the same
  const feedTxIds = (await store.bySpace('transaction', feedSpaceId))
    .filter((tx) => tx.accountId === accountId)
    .map((tx) => tx.id);
  // feed spaces carry no 'space' row, so this walks member spaces only
  const memberSpaces = (await store.allRows('space')).filter((s) => s.deleted === 0);
  for (const space of memberSpaces) {
    await purgeSpaceRemnants(store, repo, space.id, accountId, feedTxIds);
  }
}

async function purgeSpaceRemnants(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  accountId: string,
  feedTxIds: string[],
): Promise<void> {
  // #544: the rows that named the account as their counterparty let go first
  await releaseAccountReferences(store, repo, spaceId, accountId);
  for (const txId of feedTxIds) {
    const metaId = txMetaId(spaceId, txId);
    const meta = await store.get('txMeta', metaId);
    if (meta?.deleted === 0) await repo.remove('txMeta', spaceId, metaId);
  }
  for (const tx of await store.bySpace('transaction', spaceId)) {
    if (tx.deleted === 0 && tx.accountId === accountId) await repo.remove('transaction', spaceId, tx.id);
  }
}

/**
 * #544 (user): a manual account's delete. The rows that named it let go
 * first — while it is still live, so the legs munni generated on it retire
 * with those links — then the account goes. The transactions recorded ON
 * it stay (the delete sheet says so).
 */
export async function removeManualAccount(store: StorageBackend, repo: Repo, account: AccountRow): Promise<void> {
  await releaseAccountReferences(store, repo, account.spaceId, account.id);
  await repo.remove('account', account.spaceId, account.id);
}
