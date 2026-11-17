import { useData } from '@/app/data';
import { downscaleImage } from '@/lib/image';
import { measure } from '@/lib/perf';
import { receiptLinkId } from '@/domain/feedIds';
import { logActivity } from './activity';
import { writeReceiptPhoto } from './receiptFiles';
import { acceptProposal, attachReceiptTo, detachReceiptFrom, linkedTxIds, rejectProposal, releaseLink } from './receiptLinks';
import { matchReceiptEverywhere } from './receiptMatching';
import { localToday } from './recurring';
import { ensureStoreFeed, myStoreFeedId } from './storeFeed';
import type { ReceiptLinkRow, ReceiptPick, ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';

// a photo is a photo-born receiptLink: removing it IS deleting the receipt
// a fetched receipt's link is a snapshot: unlinking leaves the global row
// a remove or unlink naming a transaction lets go of that one only (one receipt may prove several)
export interface OwnReceiptFacts {
  date?: string;
  totalCents?: number;
  merchant?: string;
  items?: NonNullable<ReceiptRow['items']>;
  reconciled?: boolean;
  currency?: string;
}

export interface ReceiptOps {
  attachPhoto: (tx: Pick<SpaceTx, 'id' | 'date' | 'merchant' | 'amountCents'>, file: Blob) => Promise<void>;
  remove: (linkId: string, txId?: string) => Promise<void>;
  setItems: (linkId: string, items: ReceiptRow['items']) => Promise<void>;
  /** #567: what a reader made of the photo — its lines, whether they add up, the currency it saw */
  setRead: (linkId: string, read: { items: NonNullable<ReceiptRow['items']>; reconciled: boolean; totalCents: number; currency?: string }) => Promise<void>;
  /** #567: kept so the sheet reopens as it was left and the next receipt learns from it */
  setPicks: (linkId: string, txId: string, picks: ReceiptPick[]) => Promise<void>;
  /** a receipt attached elsewhere is attached here as well; the other transactions keep it */
  linkReceipt: (receipt: ReceiptRow, txId: string) => Promise<void>;
  unlinkReceipt: (linkId: string, txId?: string) => Promise<void>;
  /** the new link lands first so the transaction never shows empty; the old one lets go like an unlink does */
  swapReceipt: (currentLinkId: string, receipt: ReceiptRow, txId: string) => Promise<void>;
  removeGlobalReceipt: (receiptId: string) => Promise<void>;
  /** #567: a receipt kept before its transaction exists, among the person's own receipts that every space lists;
   *  null when they cannot be reached yet (an account never online here) */
  addOwnPhoto: (file: Blob) => Promise<string | null>;
  /** #567: with an amount an own photo is proposed to the payment it fits, in whichever space that is */
  setOwnFacts: (receiptId: string, facts: OwnReceiptFacts) => Promise<void>;
  acceptMatch: (link: ReceiptLinkRow) => Promise<void>;
  rejectMatch: (link: ReceiptLinkRow) => Promise<void>;
}

export function useReceiptOps(): ReceiptOps {
  const { store, repo, spaceId } = useData();
  /** a store receipt remembers the released transactions (#496), a photo goes */
  const letGo = async (linkId: string, txId: string | undefined): Promise<ReceiptLinkRow | undefined> => {
    const row = await store.get('receiptLink', linkId);
    if (!row) await repo.remove('receiptLink', spaceId, linkId);
    else if (txId !== undefined) await detachReceiptFrom(repo, spaceId, row, txId);
    else await releaseLink(repo, spaceId, row, linkedTxIds(row));
    return row;
  };
  return {
    attachPhoto: async (tx, file) => {
      // a reader can only read what is stored: small print on a long receipt needs these pixels (#567)
      const image = await downscaleImage(file, 2048, 0.8);
      const id = repo.newId();
      await repo.upsert('receiptLink', spaceId, id, {
        txId: tx.id,
        source: 'photo',
        date: tx.date,
        totalCents: Math.abs(tx.amountCents),
        merchant: tx.merchant,
        imageId: await writeReceiptPhoto(repo, spaceId, id, image),
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
    setRead: async (linkId, read) => {
      // the lines are new, so picks made on the old ones point at other lines now
      // the total is the receipt's own from here on: a photo starts with its transaction's amount as a stand-in
      await repo.upsert('receiptLink', spaceId, linkId, {
        items: read.items,
        reconciled: read.reconciled,
        picks: {},
        ...(read.totalCents > 0 ? { totalCents: read.totalCents } : {}),
        ...(read.currency ? { currency: read.currency } : {}),
      });
    },
    setPicks: async (linkId, txId, picks) => {
      const link = await store.get('receiptLink', linkId);
      if (!link || link.deleted === 1) return;
      await repo.upsert('receiptLink', spaceId, linkId, { picks: { ...link.picks, [txId]: picks } });
    },
    linkReceipt: async (receipt, txId) => {
      await measure('receipts.attach', () => attachReceiptTo(repo, spaceId, receipt, txId));
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
    addOwnPhoto: async (file) => {
      const feedId = await ensureStoreFeed(store);
      if (!feedId) return null;
      const image = await downscaleImage(file, 2048, 0.8);
      const id = repo.newId();
      // the amount is not known yet: nothing to match until it is typed or read
      await repo.upsert('receipt', feedId, id, { source: 'photo', date: localToday(), totalCents: 0, imageId: await writeReceiptPhoto(repo, feedId, id, image) });
      void logActivity(store, repo, spaceId, 'receiptAdd');
      return id;
    },
    setOwnFacts: async (receiptId, facts) => {
      const feedId = myStoreFeedId();
      if (!feedId) return;
      await repo.upsert('receipt', feedId, receiptId, facts);
      const row = await store.get('receipt', receiptId);
      if (row?.deleted === 0 && row.totalCents > 0) await matchReceiptEverywhere(store, repo, row);
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
