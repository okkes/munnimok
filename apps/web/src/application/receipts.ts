import { useData } from '@/app/data';
import { downscaleImage } from '@/lib/image';
import { logActivity } from './activity';
import type { ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';

/**
 * Photo receipts (receipts v3): a downscaled image attached straight to
 * the transaction as a photo-born `receiptLink` row — no global receipt
 * behind it (photos skip the store-feed layer), so removing the link IS
 * deleting the receipt.
 */
export interface ReceiptOps {
  /** photo path: downscale on-device, attach to the transaction */
  attachPhoto: (tx: Pick<SpaceTx, 'id' | 'date' | 'merchant' | 'amountCents'>, file: Blob) => Promise<void>;
  /** delete a photo receipt (its link id) */
  remove: (linkId: string) => Promise<void>;
  /** OCR result: line items extracted from the photo (S2) */
  setItems: (linkId: string, items: ReceiptRow['items']) => Promise<void>;
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
  };
}
