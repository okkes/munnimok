import type { AttachableReceipts } from '@/application/connections';
import type { SpaceTx } from '@/db/joined';
import type { ReceiptLinkRow } from '@/db/types';
import { REIMBURSED_ID } from '@/domain/categories';
import { autoReceiptFor } from '@/features/review/reviewReceipt';
import { candidatesFor } from './receiptPick';

/** a split container carries no receipt — its parts do */
const carriesParts = (tx: Pick<SpaceTx, 'splits'>): boolean => (tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1;

/**
 * #495 (user): a bulk update settles the siblings without their own review
 * card, so the receipt walk after it asks what each card would have asked —
 * a proposal waiting for the transaction, or, while its review was still
 * open, the unmatched receipt that really fits. One that already holds a
 * receipt asks nothing. Read from the rows as they stood BEFORE the bulk
 * wrote them (the review flag is gone after).
 */
export function receiptsToVerify(
  siblings: readonly SpaceTx[],
  inventory: AttachableReceipts | undefined,
  proposals: readonly ReceiptLinkRow[] | undefined,
): SpaceTx[] {
  if (!inventory) return [];
  return siblings.filter((tx) => {
    if (inventory.heldTxIds.has(tx.id) || carriesParts(tx)) return false;
    if (proposals?.some((link) => link.proposedTxId === tx.id && !link.txId)) return true;
    return tx.needsReview === 1 && autoReceiptFor(tx, candidatesFor(tx, inventory)) !== null;
  });
}
