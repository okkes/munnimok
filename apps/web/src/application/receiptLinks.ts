import { useMemo } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { receiptLinkId } from '@/domain/feedIds';
import { categorisedItems, itemMemoryOf } from '@/domain/receiptCats';
import type { ItemMemory } from '@/domain/receiptCats';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { LinkedReceipt, ReceiptLinkRow, ReceiptPick, ReceiptRow, StoreConnLinkRow } from '@/db/types';

// #648: a receiptLink names a receipt and holds what the space decided about it; the receipt is read where it lives —
// a feed the space includes, or the space itself — and a link whose receipt is not there shows nothing

/** the first attachment is `txId`, the others `alsoTxIds`; deduped, empties dropped; no `txId` = attached to nothing */
export function linkedTxIds(link: Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'>): string[] {
  if (!link.txId) return [];
  return [...new Set([link.txId, ...(link.alsoTxIds ?? [])].filter((id) => !!id))];
}

export const isLinkedTo = (link: Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'>, txId: string): boolean => linkedTxIds(link).includes(txId);

/** a receipt the space made itself (a photo taken on a payment): it lives and dies with the space's use of it */
export const isSpaceOwn = (link: Pick<ReceiptLinkRow, 'spaceId' | 'feedSpaceId'>): boolean => link.feedSpaceId === link.spaceId;

/** which receipt, by where it lives */
export type ReceiptRef = Pick<ReceiptRow, 'id' | 'spaceId'>;

/** what a link says about which receipt it is; written with every first write, never changed */
const naming = (receipt: ReceiptRef) => ({ receiptId: receipt.id, feedSpaceId: receipt.spaceId });

/** the feeds a space reads (a connection's receipts, a person's scans), each with the row the space keeps for it */
export async function includedFeeds(store: StorageBackend, spaceId: string): Promise<Map<string, StoreConnLinkRow>> {
  const feeds = new Map<string, StoreConnLinkRow>();
  for (const link of await store.bySpace('storeConnLink', spaceId)) {
    if (link.deleted === 0 && link.feedSpaceId) feeds.set(link.feedSpaceId, link);
  }
  return feeds;
}

/** a receipt as it is shown and filed by: its lines carry the categories its owner had suggested for them (#648) */
export const shownReceipt = (receipt: ReceiptRow): ReceiptRow => (receipt.itemCats ? { ...receipt, items: categorisedItems(receipt) } : receipt);

/** every receipt a space may put on a payment: its own and those of the feeds it reads; newest first */
export async function receiptsInSpace(store: StorageBackend, spaceId: string): Promise<ReceiptRow[]> {
  const rows = await store.bySpace('receipt', spaceId);
  for (const feedId of (await includedFeeds(store, spaceId)).keys()) rows.push(...(await store.bySpace('receipt', feedId)));
  return rows.filter((row) => row.deleted === 0).map(shownReceipt).sort((a, b) => b.date.localeCompare(a.date));
}

export async function writeReceiptLink(
  repo: Repo,
  spaceId: string,
  receipt: ReceiptRef,
  txId: string | undefined,
  auto: boolean,
): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  await repo.upsert('receiptLink', spaceId, id, {
    ...naming(receipt),
    txId: txId ?? (null as never), // explicit null clears a stale link
    // a tombstone revived by this write would keep the attachments it had: a fresh link proves one transaction
    alsoTxIds: null as never,
    auto: auto ? 1 : 0,
    proposedTxId: null as never, // an attachment settles any open proposal
  });
  return id;
}

/** `txId` stays the first attachment, further ones ride `alsoTxIds`; already attached = no-op */
export async function attachReceiptTo(repo: Repo, spaceId: string, receipt: ReceiptRef, txId: string): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  const link = await repo.store.get('receiptLink', id);
  if (link?.deleted !== 0 || !link.txId) return writeReceiptLink(repo, spaceId, receipt, txId, false);
  if (isLinkedTo(link, txId)) return id;
  await repo.upsert('receiptLink', spaceId, id, {
    alsoTxIds: [...linkedTxIds(link).filter((other) => other !== link.txId), txId],
    auto: 0,
    proposedTxId: null as never,
  });
  return id;
}

const withRejected = (link: Pick<ReceiptLinkRow, 'rejectedTxIds'>, txIds: readonly string[]): string[] => [
  ...new Set([...(link.rejectedTxIds ?? []), ...txIds]),
];

// the space's own receipt goes with its last payment; a receipt from a feed stays unattached and remembers the
// rejected transactions, so neither the matcher nor a picker offers it there again (#496)
export async function releaseLink(repo: Repo, spaceId: string, link: ReceiptLinkRow, txIds: readonly string[]): Promise<void> {
  if (isSpaceOwn(link)) {
    await repo.remove('receiptLink', spaceId, link.id);
    await repo.remove('receipt', spaceId, link.receiptId);
    return;
  }
  await repo.upsert('receiptLink', spaceId, link.id, {
    txId: null as never,
    alsoTxIds: null as never,
    proposedTxId: null as never,
    auto: 0,
    rejectedTxIds: withRejected(link, txIds),
  });
}

// the first remaining transaction becomes `txId` when the primary leaves; the last one leaving releases the link;
// the transaction it left is remembered as rejected (#496)
export async function detachReceiptFrom(repo: Repo, spaceId: string, link: ReceiptLinkRow, txId: string): Promise<void> {
  const linked = linkedTxIds(link);
  if (!linked.includes(txId)) return;
  const [first, ...rest] = linked.filter((other) => other !== txId);
  if (!first) {
    await releaseLink(repo, spaceId, link, [txId]);
    return;
  }
  await repo.upsert('receiptLink', spaceId, link.id, {
    txId: first,
    alsoTxIds: rest.length > 0 ? rest : (null as never),
    ...(isSpaceOwn(link) ? {} : { rejectedTxIds: withRejected(link, [txId]) }),
  });
}

const proposalFields = (receipt: ReceiptRef, proposedTxId: string) => ({
  ...naming(receipt),
  txId: null as never,
  alsoTxIds: null as never, // a proposal proves nothing yet
  auto: 0 as const,
  proposedTxId,
});

// #367: the best candidate was already reviewed, so the receipt asks: `proposedTxId` and no `txId`,
// listed under "Matches to check" until a human decides
export async function writeProposedLink(repo: Repo, spaceId: string, receipt: ReceiptRef, proposedTxId: string): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  await repo.upsert('receiptLink', spaceId, id, proposalFields(receipt, proposedTxId));
  return id;
}

/** a pass's proposals, committed together (#554) */
export async function writeProposedLinks(repo: Repo, spaceId: string, proposals: readonly { receipt: ReceiptRef; txId: string }[]): Promise<void> {
  await repo.upsertMany(
    'receiptLink',
    proposals.map(({ receipt, txId }) => ({ spaceId, entityId: receiptLinkId(spaceId, receipt.id), fields: proposalFields(receipt, txId) })),
  );
}

export async function acceptProposal(repo: Repo, spaceId: string, link: ReceiptLinkRow): Promise<void> {
  if (!link.proposedTxId) return;
  await repo.upsert('receiptLink', spaceId, link.id, { txId: link.proposedTxId, proposedTxId: null as never, auto: 0 });
}

/** the human disagrees: that transaction is never proposed for this receipt again */
export async function rejectProposal(repo: Repo, spaceId: string, link: ReceiptLinkRow): Promise<void> {
  if (!link.proposedTxId) return;
  await repo.upsert('receiptLink', spaceId, link.id, { proposedTxId: null as never, rejectedTxIds: withRejected(link, [link.proposedTxId]) });
}

export function useProposedMatches(): LinkedReceipt[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => (await spaceReceipts(store, spaceId)).filter((l) => !!l.proposedTxId && !l.txId), [spaceId]);
}

export const joinReceipt = (link: ReceiptLinkRow, stored: ReceiptRow, receipt = shownReceipt(stored)): LinkedReceipt => ({
  ...link,
  source: receipt.source,
  instanceId: receipt.instanceId,
  date: receipt.date,
  totalCents: receipt.totalCents,
  merchant: receipt.merchant,
  items: receipt.items,
  reconciled: receipt.reconciled,
  currency: receipt.currency,
  imageId: receipt.imageId,
  payment: receipt.payment,
  documents: receipt.documents,
  receipt,
});

/** the links of a space with the receipts they name, newest first; a link whose receipt is gone (or not here yet) is left out */
export async function linkedReceipts(store: StorageBackend, links: readonly ReceiptLinkRow[]): Promise<LinkedReceipt[]> {
  const live = links.filter((link) => link.deleted === 0 && !!link.receiptId);
  if (live.length === 0) return [];
  const receipts = new Map((await store.getMany('receipt', [...new Set(live.map((link) => link.receiptId))])).map((receipt) => [receipt.id, receipt]));
  const joined = live.flatMap((link) => {
    const receipt = receipts.get(link.receiptId);
    return receipt?.deleted === 0 ? [joinReceipt(link, receipt)] : [];
  });
  joined.sort((a, b) => b.date.localeCompare(a.date));
  return joined;
}

export async function spaceReceipts(store: StorageBackend, spaceId: string): Promise<LinkedReceipt[]> {
  return linkedReceipts(store, await store.bySpace('receiptLink', spaceId));
}

export function useSpaceReceipts(): LinkedReceipt[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => spaceReceipts(store, spaceId), [spaceId]);
}

export function useItemMemory(): ItemMemory {
  const links = useSpaceReceipts();
  return useMemo(() => itemMemoryOf(links ?? []), [links]);
}

export type ReceiptKind = 'link' | 'global';

export interface ReceiptEntry {
  /** 'link' = seen from a space that has decided something about it; 'global' = the receipt alone */
  kind: ReceiptKind;
  data: ReceiptRow;
  /** the receiptLink row id (kind 'link' — the unlink target) */
  linkId?: string;
  txId?: string;
  txIds?: string[];
  picks?: Record<string, ReceiptPick[]>;
}

export const linkAsEntry = (link: LinkedReceipt): ReceiptEntry => ({
  kind: 'link',
  data: link.receipt,
  linkId: link.id,
  txId: link.txId,
  txIds: linkedTxIds(link),
  picks: link.picks,
});

export const globalAsEntry = (row: ReceiptRow): ReceiptEntry => ({ kind: 'global', data: shownReceipt(row) });

export function useTxReceiptEntry(txId: string | undefined): ReceiptEntry | null | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      if (!txId) return null;
      const links = (await store.bySpace('receiptLink', spaceId)).filter((l) => l.deleted === 0 && isLinkedTo(l, txId));
      const [link] = await linkedReceipts(store, links);
      return link ? linkAsEntry(link) : null;
    },
    [spaceId, txId],
  );
}

/** #648: how many payments lose their receipt when these receipts go — across every space this device holds */
export async function paymentsHolding(store: StorageBackend, holds: (link: ReceiptLinkRow) => boolean): Promise<number> {
  const held = new Set<string>();
  for (const link of await store.allRows('receiptLink')) {
    if (link.deleted === 0 && holds(link)) for (const txId of linkedTxIds(link)) held.add(`${link.spaceId}:${txId}`);
  }
  return held.size;
}

/** the links to these receipts go with them, in every space this identity may write: nothing of a receipt stays behind */
export async function removeLinksTo(repo: Repo, holds: (link: ReceiptLinkRow) => boolean): Promise<void> {
  const upkeep = repo.upkeep();
  for (const link of await repo.store.allRows('receiptLink')) {
    if (link.deleted === 0 && holds(link)) await upkeep.remove('receiptLink', link.spaceId, link.id);
  }
}
