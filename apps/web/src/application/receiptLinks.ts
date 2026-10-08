import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { receiptLinkId } from '@/domain/feedIds';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { ReceiptDocument, ReceiptLinkRow, ReceiptRow } from '@/db/types';

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
  documents?: ReceiptDocument[];
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
    documents: receipt.documents,
  };
}

/**
 * Every transaction a link is attached to: the first one (`txId`), then
 * the others (user 2026-10-08: several payments, one receipt) — deduped,
 * empties dropped. A link without a `txId` is attached to nothing.
 */
export function linkedTxIds(link: Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'>): string[] {
  if (!link.txId) return [];
  return [...new Set([link.txId, ...(link.alsoTxIds ?? [])].filter((id) => !!id))];
}

export const isLinkedTo = (link: Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'>, txId: string): boolean => linkedTxIds(link).includes(txId);

/** link (or re-link) a global receipt into a space, optionally to a tx — attached to that one alone */
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
    // a tombstone revived by this write would keep the attachments it had: a fresh link proves one transaction
    alsoTxIds: null as never,
    auto: auto ? 1 : 0,
    proposedTxId: null as never, // an attachment settles any open proposal
  });
  return id;
}

/**
 * Attach a global receipt to a transaction (user 2026-10-08: "sometimes
 * multiple payments end up with 1 receipt"): no link yet, or one attached
 * to nothing, writes the snapshot link as before; a link that already
 * proves other transactions adds this one — `txId` stays the first
 * attachment, the rest ride `alsoTxIds`; attached to it already = no-op.
 */
export async function attachReceiptTo(repo: Repo, spaceId: string, receipt: ReceiptRow, txId: string): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  const link = await repo.store.get('receiptLink', id);
  if (!link || link.deleted !== 0 || !link.txId) return writeReceiptLink(repo, spaceId, receipt, txId, false);
  if (isLinkedTo(link, txId)) return id;
  await repo.upsert('receiptLink', spaceId, id, {
    alsoTxIds: [...linkedTxIds(link).filter((other) => other !== link.txId), txId],
    auto: 0,
    proposedTxId: null as never,
  });
  return id;
}

/**
 * The receipt lets go of ONE transaction (user 2026-10-08): the others keep
 * it — the first of them becomes `txId` when the primary leaves. The last
 * one leaving takes the link with it, the way an unlink or a photo's
 * delete always did (a store receipt is unmatched again, a photo is gone).
 */
export async function detachReceiptFrom(repo: Repo, spaceId: string, link: ReceiptLinkRow, txId: string): Promise<void> {
  const linked = linkedTxIds(link);
  if (!linked.includes(txId)) return;
  const [first, ...rest] = linked.filter((other) => other !== txId);
  if (!first) {
    await repo.remove('receiptLink', spaceId, link.id);
    return;
  }
  await repo.upsert('receiptLink', spaceId, link.id, { txId: first, alsoTxIds: rest.length > 0 ? rest : (null as never) });
}

/**
 * #367 (§5.7): the matcher's best candidate was already reviewed, so the
 * receipt asks instead of attaching — a link with `proposedTxId`, no
 * `txId`, listed under "Matches to check" until a human decides.
 */
export async function writeProposedLink(repo: Repo, spaceId: string, receipt: ReceiptRow, proposedTxId: string): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  await repo.upsert('receiptLink', spaceId, id, {
    ...receiptSnapshot(receipt),
    txId: null as never,
    alsoTxIds: null as never, // a proposal proves nothing yet
    auto: 0,
    proposedTxId,
  });
  return id;
}

/** the human agrees: the proposal becomes the attachment */
export async function acceptProposal(repo: Repo, spaceId: string, link: ReceiptLinkRow): Promise<void> {
  if (!link.proposedTxId) return;
  await repo.upsert('receiptLink', spaceId, link.id, { txId: link.proposedTxId, proposedTxId: null as never, auto: 0 });
}

/** the human disagrees: that transaction is never proposed for this receipt again */
export async function rejectProposal(repo: Repo, spaceId: string, link: ReceiptLinkRow): Promise<void> {
  if (!link.proposedTxId) return;
  const rejectedTxIds = [...new Set([...(link.rejectedTxIds ?? []), link.proposedTxId])];
  await repo.upsert('receiptLink', spaceId, link.id, { proposedTxId: null as never, rejectedTxIds });
}

/** the space's open proposals, newest receipt first */
export function useProposedMatches(): ReceiptLinkRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => (await spaceReceipts(store, spaceId)).filter((l) => !!l.proposedTxId && !l.txId), [spaceId]);
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
  /** the first transaction the link is attached to */
  txId?: string;
  /** every transaction the link is attached to, `txId` first (user 2026-10-08: one receipt, several payments) */
  txIds?: string[];
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
  documents: link.documents,
  fieldVersions: link.fieldVersions,
  deleted: link.deleted,
});

export const linkAsEntry = (link: ReceiptLinkRow): ReceiptEntry => ({
  kind: 'link',
  data: linkAsReceipt(link),
  linkId: link.id,
  txId: link.txId,
  txIds: linkedTxIds(link),
});

export const globalAsEntry = (row: ReceiptRow): ReceiptEntry => ({ kind: 'global', data: row });

/** the receipt attached to one transaction — as its first or as one of its further attachments */
export function useTxReceiptEntry(txId: string | undefined): ReceiptEntry | null | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      if (!txId) return null;
      const link = (await spaceReceipts(store, spaceId)).find((l) => isLinkedTo(l, txId));
      return link ? linkAsEntry(link) : null;
    },
    [spaceId, txId],
  );
}
