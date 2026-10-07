import { useData } from '@/app/data';
import { downscaleImage } from '@/lib/image';
import { receiptLinkId } from '@/domain/feedIds';
import { logActivity } from './activity';
import { acceptProposal, rejectProposal, writeReceiptLink } from './receiptLinks';
import { myStoreFeedId } from './storeFeed';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';

/**
 * Receipt actions in a space (receipts v3): a photo is a downscaled
 * image attached straight to the transaction as a photo-born
 * `receiptLink` row — no global receipt behind it, so removing the link
 * IS deleting the receipt; a fetched receipt lives in the owner's store
 * feed and its link is a snapshot — unlinking leaves the global row.
 */
export interface ReceiptOps {
  /** photo path: downscale on-device, attach to the transaction */
  attachPhoto: (tx: Pick<SpaceTx, 'id' | 'date' | 'merchant' | 'amountCents'>, file: Blob) => Promise<void>;
  /** delete a photo receipt (its link id) */
  remove: (linkId: string) => Promise<void>;
  /** OCR result: line items extracted from the photo (S2) */
  setItems: (linkId: string, items: ReceiptRow['items']) => Promise<void>;
  /** manual attach from the picker: snapshot-link a global receipt into the space */
  linkReceipt: (receipt: ReceiptRow, txId: string) => Promise<void>;
  unlinkReceipt: (linkId: string) => Promise<void>;
  /** user 2026-10-07 (Change on the transaction): another receipt takes the attached one's place — the new link
   *  lands first so the transaction never shows empty in between; the old link goes the way an unlink does
   *  (a photo is gone for good, a store receipt is unmatched again) */
  swapReceipt: (currentLinkId: string, receipt: ReceiptRow, txId: string) => Promise<void>;
  /** delete an unmatched receipt from the owner's global store feed */
  removeGlobalReceipt: (receiptId: string) => Promise<void>;
  /** "Matches to check" (§5.7): the human's yes or no on a proposal */
  acceptMatch: (link: ReceiptLinkRow) => Promise<void>;
  rejectMatch: (link: ReceiptLinkRow) => Promise<void>;
}

export function useReceiptOps(): ReceiptOps {
  const { store, repo, spaceId } = useData();
  return {
    attachPhoto: async (tx, file) => {
      // receipts want more pixels than avatars — text must stay readable
      const image = await downscaleImage(file, 1280, 0.7);
      await repo.upsert('receiptLink', spaceId, repo.newId(), {
        txId: tx.id,
        source: 'photo',
        date: tx.date,
        totalCents: Math.abs(tx.amountCents),
        merchant: tx.merchant,
        image,
        auto: 0,
      });
      void logActivity(store, repo, spaceId, 'receiptAdd', tx.merchant);
    },
    remove: async (linkId) => {
      const row = await store.get('receiptLink', linkId);
      await repo.remove('receiptLink', spaceId, linkId);
      void logActivity(store, repo, spaceId, 'receiptRemove', row?.merchant);
    },
    setItems: async (linkId, items) => {
      await repo.upsert('receiptLink', spaceId, linkId, { items });
    },
    linkReceipt: async (receipt, txId) => {
      await writeReceiptLink(repo, spaceId, receipt, txId, false);
      void logActivity(store, repo, spaceId, 'receiptAdd', receipt.merchant);
    },
    unlinkReceipt: async (linkId) => {
      await repo.remove('receiptLink', spaceId, linkId);
      void logActivity(store, repo, spaceId, 'receiptRemove');
    },
    swapReceipt: async (currentLinkId, receipt, txId) => {
      if (receiptLinkId(spaceId, receipt.id) === currentLinkId) return; // the attached one again: nothing to swap
      const current = await store.get('receiptLink', currentLinkId);
      await writeReceiptLink(repo, spaceId, receipt, txId, false);
      await repo.remove('receiptLink', spaceId, currentLinkId);
      void logActivity(store, repo, spaceId, 'receiptRemove', current?.merchant);
      void logActivity(store, repo, spaceId, 'receiptAdd', receipt.merchant);
    },
    removeGlobalReceipt: async (receiptId) => {
      const feedId = myStoreFeedId();
      if (feedId) {
        const row = await store.get('receipt', receiptId);
        await repo.remove('receipt', feedId, receiptId);
        void logActivity(store, repo, spaceId, 'receiptRemove', row?.merchant);
      }
    },
    acceptMatch: async (link) => {
      await acceptProposal(repo, spaceId, link);
      void logActivity(store, repo, spaceId, 'receiptAdd', link.merchant);
    },
    rejectMatch: async (link) => {
      await rejectProposal(repo, spaceId, link);
    },
  };
}
