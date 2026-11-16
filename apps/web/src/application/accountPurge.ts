import { txMetaId } from '@/domain/feedIds';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow } from '@/db/types';
import { releaseAccountReferences } from './accountRelease';
import { settleSpaceReimbursements } from './catalogMaintenance';

// #279: engine.purgeSpace is feed-space keyed, so member spaces kept txMeta overlays (syncing forever) and own rows on
// the account. Tombstone both via the repo (a raw delete resurrects on the next pull), BEFORE the engine purge,
// while the feed's transaction ids are still readable
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
  await releaseAccountReferences(store, repo, spaceId, accountId);
  for (const txId of feedTxIds) {
    const metaId = txMetaId(spaceId, txId);
    const meta = await store.get('txMeta', metaId);
    if (meta?.deleted === 0) await repo.remove('txMeta', spaceId, metaId);
  }
  for (const tx of await store.bySpace('transaction', spaceId)) {
    if (tx.deleted === 0 && tx.accountId === accountId) await repo.remove('transaction', spaceId, tx.id);
  }
  // #617: a reimbursement that named one of those rows is none any more
  await settleSpaceReimbursements(store, repo, spaceId);
}

// #544: a manual account's delete: references let go first while it is live, so generated legs retire with the links;
// transactions recorded ON it stay
export async function removeManualAccount(store: StorageBackend, repo: Repo, account: AccountRow): Promise<void> {
  await releaseAccountReferences(store, repo, account.spaceId, account.id);
  await repo.remove('account', account.spaceId, account.id);
}
