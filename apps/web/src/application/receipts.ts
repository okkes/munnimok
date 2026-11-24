import { useData } from '@/app/data';
import { downscaleImage } from '@/lib/image';
import { measure } from '@/lib/perf';
import { receiptLinkId } from '@/domain/feedIds';
import { logActivity } from './activity';
import { writeReceiptPhoto } from './receiptFiles';
import { acceptProposal, attachReceiptTo, detachReceiptFrom, linkedTxIds, rejectProposal, releaseLink, removeLinksTo, writeReceiptLink } from './receiptLinks';
import type { ReceiptRef } from './receiptLinks';
import { matchReceiptEverywhere } from './receiptMatching';
import { localToday } from './recurring';
import { ensureScansFeed, shareScansLocally } from './storeFeed';
import type { ReceiptLinkRow, ReceiptPick, ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';

// #648: a receipt lives once, where it was made — a photo taken on a payment in that payment's space, a scan in its
// owner's scans feed, a fetched one in its connection's feed. Taking it off a payment changes the space's link only;
// what a reader found is written to the receipt itself, by whoever may write where it lives
export interface OwnReceiptFacts {
  date?: string;
  totalCents?: number;
  merchant?: string;
  items?: NonNullable<ReceiptRow['items']>;
  reconciled?: boolean;
  currency?: string;
}

export interface ReceiptOps {
  /** resolves to the id of the link that ties the new receipt (the space's own) to the payment */
  attachPhoto: (tx: Pick<SpaceTx, 'id' | 'date' | 'merchant' | 'amountCents'>, file: Blob) => Promise<string>;
  remove: (linkId: string, txId?: string) => Promise<void>;
  /** false when the receipt is somebody else's to change (a feed this identity only reads) */
  canEdit: (receipt: ReceiptRef) => boolean;
  setItems: (receipt: ReceiptRef, items: ReceiptRow['items']) => Promise<void>;
  /** #567: what a reader made of the photo — its lines, whether they add up, the currency it saw, and for a scan
   *  (which has no transaction to take them from) the shop and the day as printed */
  setRead: (
    receipt: ReceiptRef,
    read: { items: NonNullable<ReceiptRow['items']>; reconciled: boolean; totalCents: number; currency?: string; merchant?: string; date?: string },
  ) => Promise<void>;
  /** #648: the picture goes, the receipt and its lines stay — on every device, and out of the server's log */
  removePhoto: (receipt: ReceiptRef) => Promise<void>;
  /** #567: kept so the sheet reopens as it was left and the next receipt learns from it */
  setPicks: (linkId: string, txId: string, picks: ReceiptPick[]) => Promise<void>;
  /** a receipt attached elsewhere is attached here as well; the other transactions keep it */
  linkReceipt: (receipt: ReceiptRow, txId: string) => Promise<void>;
  unlinkReceipt: (linkId: string, txId?: string) => Promise<void>;
  /** the new link lands first so the transaction never shows empty; the old one lets go like an unlink does */
  swapReceipt: (currentLinkId: string, receipt: ReceiptRow, txId: string) => Promise<void>;
  /** #648: the receipt is gone for everyone who read it, and from every payment it was on */
  removeReceipt: (receipt: ReceiptRef) => Promise<void>;
  /** #567: a receipt kept before its transaction exists, among the person's own scans;
   *  null when they cannot be reached yet (an account never online here) */
  addOwnPhoto: (file: Blob) => Promise<string | null>;
  /** #567: with an amount an own scan is proposed to the payment it fits, in whichever space reads the scans */
  setOwnFacts: (receipt: ReceiptRef, facts: OwnReceiptFacts) => Promise<void>;
  acceptMatch: (link: ReceiptLinkRow) => Promise<void>;
  rejectMatch: (link: ReceiptLinkRow) => Promise<void>;
}

export function useReceiptOps(): ReceiptOps {
  const { store, repo, spaceId } = useData();
  /** a receipt from a feed remembers the released transactions (#496), the space's own goes */
  const letGo = async (linkId: string, txId: string | undefined): Promise<ReceiptRow | undefined> => {
    const row = await store.get('receiptLink', linkId);
    if (!row) return undefined;
    const receipt = await store.get('receipt', row.receiptId);
    if (txId !== undefined) await detachReceiptFrom(repo, spaceId, row, txId);
    else await releaseLink(repo, spaceId, row, linkedTxIds(row));
    return receipt;
  };
  /** an amount (typed or read) is what a scan is recognised by: it is offered to the payment it fits */
  const offer = async (receipt: ReceiptRef) => {
    const row = await store.get('receipt', receipt.id);
    if (row?.deleted === 0 && row.totalCents > 0 && row.spaceId !== spaceId) await matchReceiptEverywhere(store, repo, row);
  };
  return {
    attachPhoto: async (tx, file) => {
      // a reader can only read what is stored: small print on a long receipt needs these pixels (#567)
      const image = await downscaleImage(file, 2048, 0.8);
      const id = repo.newId();
      await repo.upsert('receipt', spaceId, id, {
        source: 'photo',
        date: tx.date,
        totalCents: Math.abs(tx.amountCents),
        merchant: tx.merchant,
        imageId: await writeReceiptPhoto(repo, spaceId, id, image),
      });
      const linkId = await writeReceiptLink(repo, spaceId, { id, spaceId }, tx.id, false);
      void logActivity(store, repo, spaceId, 'receiptAdd', tx.merchant);
      return linkId;
    },
    remove: async (linkId, txId) => {
      const receipt = await letGo(linkId, txId);
      void logActivity(store, repo, spaceId, 'receiptRemove', receipt?.merchant);
    },
    canEdit: (receipt) => repo.canWrite(receipt.spaceId),
    setItems: async (receipt, items) => {
      await repo.upsert('receipt', receipt.spaceId, receipt.id, { items });
    },
    setRead: async (receipt, read) => {
      // the total is the receipt's own from here on: a photo starts with its transaction's amount as a stand-in;
      // a photo taken on a payment keeps that payment's shop and day, a scan has only what is printed
      const scan = receipt.spaceId !== spaceId;
      await repo.upsert('receipt', receipt.spaceId, receipt.id, {
        items: read.items,
        reconciled: read.reconciled,
        ...(read.totalCents > 0 ? { totalCents: read.totalCents } : {}),
        ...(read.currency ? { currency: read.currency } : {}),
        ...(scan && read.merchant ? { merchant: read.merchant } : {}),
        ...(scan && read.date ? { date: read.date } : {}),
      });
      // the lines are new, so picks made on the old ones point at other lines now — in every space that picked
      const upkeep = repo.upkeep();
      for (const link of await store.allRows('receiptLink')) {
        if (link.deleted === 0 && link.receiptId === receipt.id && link.picks && Object.keys(link.picks).length > 0) {
          await upkeep.upsert('receiptLink', link.spaceId, link.id, { picks: {} });
        }
      }
      await offer(receipt);
    },
    removePhoto: async (receipt) => {
      const fileId = (await store.get('receipt', receipt.id))?.imageId;
      if (!fileId) return;
      await repo.batch(async () => {
        await repo.upsert('receipt', receipt.spaceId, receipt.id, { imageId: null as never });
        // emptied before it is removed: the row shrinks on every device, and the server drops the picture from its log
        await repo.upsert('receiptFile', receipt.spaceId, fileId, { dataUrl: '' });
        await repo.remove('receiptFile', receipt.spaceId, fileId);
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
      await attachReceiptTo(repo, spaceId, receipt, txId);
      const current = await letGo(currentLinkId, txId);
      void logActivity(store, repo, spaceId, 'receiptRemove', current?.merchant);
      void logActivity(store, repo, spaceId, 'receiptAdd', receipt.merchant);
    },
    removeReceipt: async (receipt) => {
      const row = await store.get('receipt', receipt.id);
      await repo.remove('receipt', receipt.spaceId, receipt.id);
      await removeLinksTo(repo, (link) => link.receiptId === receipt.id);
      void logActivity(store, repo, spaceId, 'receiptRemove', row?.merchant);
    },
    addOwnPhoto: async (file) => {
      const feedId = await ensureScansFeed(store);
      if (!feedId) return null;
      const image = await downscaleImage(file, 2048, 0.8);
      const id = repo.newId();
      // the amount is not known yet: nothing to match until it is typed or read
      await repo.upsert('receipt', feedId, id, { source: 'photo', date: localToday(), totalCents: 0, imageId: await writeReceiptPhoto(repo, feedId, id, image) });
      // an identity that never syncs shares with nobody: its first scan is at once every space's to use
      await shareScansLocally(store, repo);
      void logActivity(store, repo, spaceId, 'receiptAdd');
      return id;
    },
    setOwnFacts: async (receipt, facts) => {
      await repo.upsert('receipt', receipt.spaceId, receipt.id, facts);
      await offer(receipt);
    },
    acceptMatch: async (link) => {
      await acceptProposal(repo, spaceId, link);
      const receipt = await store.get('receipt', link.receiptId);
      void logActivity(store, repo, spaceId, 'receiptAdd', receipt?.merchant);
    },
    rejectMatch: async (link) => {
      await rejectProposal(repo, spaceId, link);
    },
  };
}
