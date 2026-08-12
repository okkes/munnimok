import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { writeTxTransform } from '@/db/joined';
import { accountStamp, movementCatFor } from '@/domain/txType';
import { autoSubFor, stampMovementSub } from '@/domain/categories';

/**
 * #133 step B — the pick-existing door's SECOND half: the source row's
 * own write already carried `transferPeerId = picked` (so the mirror
 * engine minted nothing); this writes the reciprocal onto the picked
 * row — link back, peer back, and the category its own account's stamp
 * dictates. Both writes carry their peer in the SAME write, so neither
 * side ever mints. Balances stay untouched: the picked row was already
 * part of its account's declared reality ("nothing is minted, nothing
 * moves").
 */
export async function pairWithExistingRow(
  store: StorageBackend,
  repo: Repo,
  source: { id: string; accountId: string },
  pickedTxId: string,
): Promise<void> {
  const picked = await store.get('transaction', pickedTxId);
  if (picked?.deleted !== 0) return;
  const account = await store.get('account', picked.accountId);
  const stamp = account?.deleted === 0 ? accountStamp(account.type) : undefined;
  // #133 r5: an unstamped picked row files by ITS counter's kind (the
  // source account) — the bijection holds on both sides of the pair
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
