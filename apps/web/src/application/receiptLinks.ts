import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { receiptLinkId } from '@/domain/feedIds';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';

/**
 * Receipts v3 (approved redesign, rulings 1+2): the per-space presence
 * of a receipt is a `receiptLink` row carrying a SNAPSHOT of the
 * payload. Linked receipts therefore follow the transactions — they
 * survive the owner leaving the space and the connection instance being
 * removed — because rendering them never needs the owner's store feed.
 */

/** the payload fields a link snapshot carries */
export interface ReceiptSnapshot {
  receiptId?: string;
  source: ReceiptRow['source'];
  instanceId?: string;
  date: string;
  totalCents: number;
  merchant?: string;
  items?: ReceiptRow['items'];
  image?: string;
  payment?: ReceiptRow['payment'];
}

/** the snapshot a link carries, built from a global receipt row */
export function receiptSnapshot(receipt: ReceiptRow): ReceiptSnapshot {
  return {
    receiptId: receipt.id,
    source: receipt.source,
    instanceId: receipt.instanceId,
    date: receipt.date,
    totalCents: receipt.totalCents,
    merchant: receipt.merchant,
    items: receipt.items,
    image: receipt.image,
    payment: receipt.payment,
  };
}

/** link (or re-link) a global receipt into a space, optionally to a tx */
export async function writeReceiptLink(
  repo: Repo,
  spaceId: string,
  receipt: ReceiptRow,
  txId: string | undefined,
  auto: boolean,
): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  await repo.upsert('receiptLink', spaceId, id, {
    ...receiptSnapshot(receipt),
    txId: txId ?? (null as never), // explicit null clears a stale link
    auto: auto ? 1 : 0,
  });
  return id;
}

/** every receipt visible in a space: its snapshot links (store receipts
 *  linked in, photo-born ones), newest first */
export async function spaceReceipts(store: StorageBackend, spaceId: string): Promise<ReceiptLinkRow[]> {
  const links = (await store.bySpace('receiptLink', spaceId)).filter((l) => l.deleted === 0);
  links.sort((a, b) => b.date.localeCompare(a.date));
  return links;
}

export function useSpaceReceipts(): ReceiptLinkRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => spaceReceipts(store, spaceId), [spaceId]);
}

// ── normalized entries (what the screens render and act on) ──────────────

export type ReceiptKind = 'link' | 'global';

/** one receipt as a screen sees it: a space's snapshot link, or an
 *  owner's still-unmatched global receipt */
export interface ReceiptEntry {
  kind: ReceiptKind;
  /** ReceiptRow-shaped payload — rendering + linking always work on this */
  data: ReceiptRow;
  /** the receiptLink row id (kind 'link' — the unlink/delete target) */
  linkId?: string;
  txId?: string;
}

const linkAsReceipt = (link: ReceiptLinkRow): ReceiptRow => ({
  id: link.receiptId ?? link.id,
  spaceId: link.spaceId,
  source: link.source,
  date: link.date,
  totalCents: link.totalCents,
  merchant: link.merchant,
  items: link.items,
  image: link.image,
  instanceId: link.instanceId,
  payment: link.payment,
  fieldVersions: link.fieldVersions,
  deleted: link.deleted,
});

export const linkAsEntry = (link: ReceiptLinkRow): ReceiptEntry => ({
  kind: 'link',
  data: linkAsReceipt(link),
  linkId: link.id,
  txId: link.txId,
});

export const globalAsEntry = (row: ReceiptRow): ReceiptEntry => ({ kind: 'global', data: row });

/** the receipt attached to one transaction */
export function useTxReceiptEntry(txId: string | undefined): ReceiptEntry | null | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      if (!txId) return null;
      const link = (await spaceReceipts(store, spaceId)).find((l) => l.txId === txId);
      return link ? linkAsEntry(link) : null;
    },
    [spaceId, txId],
  );
}
