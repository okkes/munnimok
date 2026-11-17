import { useMemo } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { receiptLinkId } from '@/domain/feedIds';
import { itemMemoryOf } from '@/domain/receiptCats';
import type { ItemMemory } from '@/domain/receiptCats';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { ReceiptDocument, ReceiptLinkRow, ReceiptPick, ReceiptRow } from '@/db/types';

// a receiptLink snapshots the receipt payload, so linked receipts outlive the owner leaving or the connection going

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
  currency?: string;
  reconciled?: boolean;
}

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
    // the party's currency and its "lines do not add up" travel with the copy: members read them without the owner's feed
    ...(receipt.currency ? { currency: receipt.currency } : {}),
    ...(receipt.reconciled === false ? { reconciled: false } : {}),
  };
}

/** the first attachment is `txId`, the others `alsoTxIds`; deduped, empties dropped; no `txId` = attached to nothing */
export function linkedTxIds(link: Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'>): string[] {
  if (!link.txId) return [];
  return [...new Set([link.txId, ...(link.alsoTxIds ?? [])].filter((id) => !!id))];
}

export const isLinkedTo = (link: Pick<ReceiptLinkRow, 'txId' | 'alsoTxIds'>, txId: string): boolean => linkedTxIds(link).includes(txId);

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

/** `txId` stays the first attachment, further ones ride `alsoTxIds`; already attached = no-op */
export async function attachReceiptTo(repo: Repo, spaceId: string, receipt: ReceiptRow, txId: string): Promise<string> {
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

// a photo-born link IS the receipt and goes; a store receipt stays unattached and remembers the rejected transactions,
// so neither the matcher nor a picker offers it there again (#496)
export async function releaseLink(repo: Repo, spaceId: string, link: ReceiptLinkRow, txIds: readonly string[]): Promise<void> {
  if (!link.receiptId) {
    await repo.remove('receiptLink', spaceId, link.id);
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
    ...(link.receiptId ? { rejectedTxIds: withRejected(link, [txId]) } : {}),
  });
}

// #367: the best candidate was already reviewed, so the receipt asks: `proposedTxId` and no `txId`,
// listed under "Matches to check" until a human decides
export async function writeProposedLink(repo: Repo, spaceId: string, receipt: ReceiptRow, proposedTxId: string): Promise<string> {
  const id = receiptLinkId(spaceId, receipt.id);
  await repo.upsert('receiptLink', spaceId, id, proposalFields(receipt, proposedTxId));
  return id;
}

const proposalFields = (receipt: ReceiptRow, proposedTxId: string) => ({
  ...receiptSnapshot(receipt),
  txId: null as never,
  alsoTxIds: null as never, // a proposal proves nothing yet
  auto: 0 as const,
  proposedTxId,
});

/** a pass's proposals, committed together (#554) */
export async function writeProposedLinks(repo: Repo, spaceId: string, proposals: readonly { receipt: ReceiptRow; txId: string }[]): Promise<void> {
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

export function useProposedMatches(): ReceiptLinkRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => (await spaceReceipts(store, spaceId)).filter((l) => !!l.proposedTxId && !l.txId), [spaceId]);
}

export async function spaceReceipts(store: StorageBackend, spaceId: string): Promise<ReceiptLinkRow[]> {
  const links = (await store.bySpace('receiptLink', spaceId)).filter((l) => l.deleted === 0);
  links.sort((a, b) => b.date.localeCompare(a.date));
  return links;
}

export function useSpaceReceipts(): ReceiptLinkRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(store, async () => spaceReceipts(store, spaceId), [spaceId]);
}

export function useItemMemory(): ItemMemory {
  const links = useSpaceReceipts();
  return useMemo(() => itemMemoryOf(links ?? []), [links]);
}

export type ReceiptKind = 'link' | 'global';

export interface ReceiptEntry {
  kind: ReceiptKind;
  data: ReceiptRow;
  /** the receiptLink row id (kind 'link' — the unlink/delete target) */
  linkId?: string;
  txId?: string;
  txIds?: string[];
  picks?: Record<string, ReceiptPick[]>;
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
  currency: link.currency,
  reconciled: link.reconciled,
  fieldVersions: link.fieldVersions,
  deleted: link.deleted,
});

export const linkAsEntry = (link: ReceiptLinkRow): ReceiptEntry => ({
  kind: 'link',
  data: linkAsReceipt(link),
  linkId: link.id,
  txId: link.txId,
  txIds: linkedTxIds(link),
  picks: link.picks,
});

export const globalAsEntry = (row: ReceiptRow): ReceiptEntry => ({ kind: 'global', data: row });

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
