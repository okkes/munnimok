import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { visibleTransactions, writeTxTransform, type SpaceTx } from '@/db/joined';
import { accountStamp, movementCatFor } from '@/domain/txType';
import { autoSubFor, stampMovementSub } from '@/domain/categories';

// pick-existing door, second half (#133): both rows carry their peer in the SAME write, so neither mints; balances stay
// #237: a same-sign pick is the wallet story: the picked row is the real purchase and keeps its category
// #237 r2: resolve the picked row through the joined view: a raw feed row's reciprocal lands where no reader looks
// a minted part-leg's back-pointer is the part-mirror source key "rowId:partId" (#255 r4); the row's own transferPeerId
// is the caller's write
export async function releasePeerLeg(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  tx: SpaceTx,
  allTxs: SpaceTx[] | undefined,
): Promise<void> {
  const peerId = tx.transferPeerId;
  if (!peerId) return;
  const peer =
    (allTxs ?? []).find((item) => item.id === peerId) ??
    (await visibleTransactions(store, spaceId)).find((item) => item.id === peerId);
  if (peer) {
    await writeTxTransform(repo, peer, { transferPeerId: null as never });
    return;
  }
  const colon = peerId.indexOf(':');
  if (colon <= 0) return;
  const ownerId = peerId.slice(0, colon);
  const partId = peerId.slice(colon + 1);
  const owner =
    (allTxs ?? []).find((item) => item.id === ownerId) ??
    (await visibleTransactions(store, spaceId)).find((item) => item.id === ownerId);
  if (owner?.splits?.some((s) => s.id === partId && s.transferPeerId === tx.id)) {
    await writeTxTransform(repo, owner, {
      splits: owner.splits.map((s) => (s.id === partId ? { ...s, transferPeerId: undefined } : s)),
    });
  }
}

export async function pairWithExistingRow(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  source: { id: string; accountId: string; amountCents?: number },
  pickedTxId: string,
  rows?: SpaceTx[],
): Promise<void> {
  const picked =
    (rows ?? []).find((row) => row.id === pickedTxId) ??
    (await visibleTransactions(store, spaceId)).find((row) => row.id === pickedTxId);
  if (picked?.deleted !== 0) return;
  if (source.amountCents !== undefined && Math.sign(picked.amountCents) === Math.sign(source.amountCents)) {
    await writeTxTransform(repo, picked, { transferPeerId: source.id });
    return;
  }
  const account = await store.get('account', picked.accountId);
  const stamp = account?.deleted === 0 ? accountStamp(account.type) : undefined;
  // #133 r5: an unstamped picked row files by its counter's kind (the source account)
  // it leaves the review: every caller is the person pointing at this exact row, so the category is their decision
  const sourceType = (await store.get('account', source.accountId))?.type;
  await writeTxTransform(repo, picked, {
    linkedAccountId: source.accountId,
    transferPeerId: source.id,
    catId:
      (stamp ? stampMovementSub(stamp, picked.amountCents) : undefined) ??
      (sourceType ? movementCatFor(sourceType, picked.amountCents) : autoSubFor('transfer', picked.amountCents)),
    needsReview: 0,
  });
}
