import { useData } from '@/app/data';
import { downscaleImage } from '@/lib/image';
import { receiptLinkId } from '@/domain/feedIds';
import { logActivity } from './activity';
import { acceptProposal, attachReceiptTo, detachReceiptFrom, rejectProposal } from './receiptLinks';
import { myStoreFeedId } from './storeFeed';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';

/**
 * Receipt actions in a space (receipts v3): a photo is a downscaled
 * image attached straight to the transaction as a photo-born
 * `receiptLink` row — no global receipt behind it, so removing the link
 * IS deleting the receipt; a fetched receipt lives in the owner's store
 * feed and its link is a snapshot — unlinking leaves the global row.
 * One receipt may prove several transactions (user 2026-10-08): a
 * remove or unlink that names a transaction lets go of that one only,
 * and the link survives while another transaction still holds it.
 */
export interface ReceiptOps {
  /** photo path: downscale on-device, attach to the transaction */
  attachPhoto: (tx: Pick<SpaceTx, 'id' | 'date' | 'merchant' | 'amountCents'>, file: Blob) => Promise<void>;
  /** delete a photo receipt (its link id) — or, with a transaction named, detach it from that one alone */
  remove: (linkId: string, txId?: string) => Promise<void>;
  /** OCR result: line items extracted from the photo (S2) */
  setItems: (linkId: string, items: ReceiptRow['items']) => Promise<void>;
  /** manual attach from the picker: snapshot-link a global receipt into the space — a receipt attached
   *  elsewhere is attached here as well, the other transactions keep it */
  linkReceipt: (receipt: ReceiptRow, txId: string) => Promise<void>;
  /** the whole link, or — with a transaction named — that transaction's hold on it alone */
  unlinkReceipt: (linkId: string, txId?: string) => Promise<void>;
  /** user 2026-10-07 (Change on the transaction): another receipt takes the attached one's place — the new link
   *  lands first so the transaction never shows empty in between; the old one lets go of THIS transaction the way
   *  an unlink does (a photo nobody else holds is gone for good, a store receipt nobody else holds is unmatched again) */
  swapReceipt: (currentLinkId: string, receipt: ReceiptRow, txId: string) => Promise<void>;
  /** delete an unmatched receipt from the owner's global store feed */
  removeGlobalReceipt: (receiptId: string) => Promise<void>;
  /** "Matches to check" (§5.7): the human's yes or no on a proposal */
  acceptMatch: (link: ReceiptLinkRow) => Promise<void>;
  rejectMatch: (link: ReceiptLinkRow) => Promise<void>;
}

export function useReceiptOps(): ReceiptOps {
  const { store, repo, spaceId } = useData();
  /** the link lets go of one transaction (the others keep it), or goes entirely when none is named */
  const letGo = async (linkId: string, txId: string | undefined): Promise<ReceiptLinkRow | undefined> => {
    const row = await store.get('receiptLink', linkId);
    if (txId !== undefined && row) await detachReceiptFrom(repo, spaceId, row, txId);
    else await repo.remove('receiptLink', spaceId, linkId);
    return row;
  };
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
    remove: async (linkId, txId) => {
      const row = await letGo(linkId, txId);
      void logActivity(store, repo, spaceId, 'receiptRemove', row?.merchant);
    },
    setItems: async (linkId, items) => {
      await repo.upsert('receiptLink', spaceId, linkId, { items });
    },
    linkReceipt: async (receipt, txId) => {
      await attachReceiptTo(repo, spaceId, receipt, txId);
      void logActivity(store, repo, spaceId, 'receiptAdd', receipt.merchant);
    },
    unlinkReceipt: async (linkId, txId) => {
      await letGo(linkId, txId);
      void logActivity(store, repo, spaceId, 'receiptRemove');
    },
    swapReceipt: async (currentLinkId, receipt, txId) => {
      if (receiptLinkId(spaceId, receipt.id) === currentLinkId) return; // the attached one again: nothing to swap
      const current = await store.get('receiptLink', currentLinkId);
      await attachReceiptTo(repo, spaceId, receipt, txId);
      await letGo(currentLinkId, txId);
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
