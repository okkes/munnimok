import { useLiveQuery } from 'dexie-react-hooks';
import { useData } from '@/app/data';
import { downscaleImage } from '@/lib/image';
import type { ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';

/** the receipt attached to one transaction (photo or store) */
export function useTxReceipt(txId: string | undefined): ReceiptRow | null | undefined {
  const { db, spaceId } = useData();
  return useLiveQuery(
    async () => {
      if (!txId) return null;
      const rows = await db.receipts.where('txId').equals(txId).filter((r) => r.deleted === 0 && r.spaceId === spaceId).toArray();
      return rows[0] ?? null;
    },
    [db, spaceId, txId],
  );
}

export interface ReceiptOps {
  /** photo path: downscale on-device, attach to the transaction */
  attachPhoto: (tx: Pick<SpaceTx, 'id' | 'date' | 'merchant' | 'amountCents'>, file: Blob) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

export function useReceiptOps(): ReceiptOps {
  const { repo, spaceId } = useData();
  return {
    attachPhoto: async (tx, file) => {
      // receipts want more pixels than avatars — text must stay readable
      const image = await downscaleImage(file, 1280, 0.7);
      await repo.upsert('receipt', spaceId, repo.newId(), {
        txId: tx.id,
        source: 'photo',
        date: tx.date,
        totalCents: Math.abs(tx.amountCents),
        merchant: tx.merchant,
        image,
      });
    },
    remove: (id) => repo.remove('receipt', spaceId, id),
  };
}
