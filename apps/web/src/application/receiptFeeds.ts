import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { EntityName, ReceiptDocument, ReceiptRow } from '@/db/types';
import { importOpId, movedReceiptId, receiptFileId, receiptLinkId, spaceReceiptId } from '@/domain/feedIds';
import { compareHlc } from '@/sync/hlc';
import { DELETED_FIELD } from '@/sync/merge';
import type { SyncEnvelope } from '@/sync/merge';
import { documentSlot, fileWrite, IMAGE_SLOT } from './receiptFiles';
import { includedFeeds } from './receiptLinks';
import { ensureReceiptFeed, ensureScansFeed, myStoreFeedId, shareFeed, shareScansLocally } from './storeFeed';

// #648: every receipt a person fetched or scanned sat in ONE feed only they could read, and a space kept a full copy
// of each receipt it linked. Now a receipt lives once (its connection's feed, the scans feed, or the space that made
// it) and a link only names it. The server moved every row it holds (ReceiptFeeds.cs); a device does the same for what
// it still holds in the old shape — a row the server never saw as it is here, a store that never syncs — with the
// same ids, each value stamped right behind the stamp it had: whoever comes second changes nothing

type Stamped = Parameters<Repo['upsertStamped']>[1][number];
type Held = Record<string, unknown> & SyncEnvelope & { id: string; spaceId: string };

const ENVELOPE = new Set(['id', 'spaceId', 'fieldVersions', 'deleted']);
/** what a space decided about a receipt: the whole of a link from here on */
const LINK_STATE = ['txId', 'alsoTxIds', 'picks', 'auto', 'proposedTxId', 'rejectedTxIds'];
/** what a link's copy said about the receipt itself; a newer value than the receipt's own (a read made on the copy) is kept */
const FACTS = ['date', 'totalCents', 'merchant', 'items', 'reconciled', 'currency', 'payment'];
/** a copy that becomes the space's own receipt takes everything it held, its files (which stay where they are) included */
const OWN_FACTS = ['source', 'instanceId', ...FACTS, 'imageId', 'documents', 'image'];

/** the stamp right behind another: it replaces exactly the value that stamp wrote, and loses to every later write */
const behind = (stamp: string): string => `${stamp}~`;

const ordinal = (a: string, b: string): number => compareHlc(a, b);

const pick = (row: Record<string, unknown>, names: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(names.filter((name) => name in row).map((name) => [name, row[name]]));

const valuesOf = (row: Held): Record<string, unknown> => Object.fromEntries(Object.entries(row).filter(([name]) => !ENVELOPE.has(name)));

/** values that were written together travel together, and the change is named by what it carries (the server's MoveOps) */
export function moveWrites(spaceId: string, entity: EntityName, entityId: string, fields: Record<string, unknown>, stamps: Record<string, string>): Stamped[] {
  const groups = new Map<string, string[]>();
  for (const name of Object.keys(fields)) {
    const stamp = stamps[name];
    if (!stamp) continue;
    groups.set(stamp, [...(groups.get(stamp) ?? []), name]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => ordinal(a, b))
    .map(([stamp, unsorted]) => {
      const names = [...unsorted].sort(ordinal);
      return {
        entity,
        entityId,
        fields: Object.fromEntries(names.map((name) => [name, fields[name]])),
        hlc: behind(stamp),
        opId: importOpId(`move:${spaceId}:${entity}:${entityId}:${stamp}:${names.join(',')}`),
      };
    });
}

/** the row a move left behind, removed right behind its newest value (the server's GoneOp) */
export function goneWrite(spaceId: string, entity: EntityName, entityId: string, stamps: Record<string, string>): Stamped {
  const last = Object.entries(stamps)
    .filter(([name]) => name !== DELETED_FIELD)
    .map(([, stamp]) => stamp)
    .reduce((max, stamp) => (ordinal(stamp, max) > 0 ? stamp : max), '');
  // a row without a single stamped value was never written: the lowest stamp there is
  const stamp = last || '000000000-0000-server';
  return { entity, entityId, fields: {}, hlc: behind(stamp), opId: importOpId(`moved:${spaceId}:${entity}:${entityId}:${stamp}`), deleted: true };
}

async function targetFeed(store: StorageBackend, receipt: Pick<ReceiptRow, 'instanceId'>): Promise<string | null> {
  return receipt.instanceId ? ensureReceiptFeed(store, receipt.instanceId) : ensureScansFeed(store);
}

/** the receipt's photo and invoices under its new id, in its new feed; the fields name them from here on */
async function moveFiles(store: StorageBackend, newId: string, fields: Record<string, unknown>): Promise<Stamped[]> {
  const writes: Stamped[] = [];
  const carry = async (fromId: string, toId: string) => {
    const file = await store.get('receiptFile', fromId);
    const stamp = file?.fieldVersions.dataUrl;
    if (file?.deleted === 0 && file.dataUrl && stamp) writes.push(await fileWrite(newId, toId, file.dataUrl, behind(stamp)));
  };
  if (typeof fields.imageId === 'string' && fields.imageId) {
    const to = receiptFileId(newId, IMAGE_SLOT);
    await carry(fields.imageId, to);
    fields.imageId = to;
  }
  if (Array.isArray(fields.documents)) {
    const documents: ReceiptDocument[] = [];
    for (const [index, document] of (fields.documents as ReceiptDocument[]).entries()) {
      if (!document?.fileId) {
        documents.push(document);
        continue;
      }
      const to = receiptFileId(newId, documentSlot(index));
      await carry(document.fileId, to);
      documents.push({ ...document, fileId: to });
    }
    fields.documents = documents;
  }
  return writes;
}

/** my receipts leave the feed that held them all, each for its connection's feed or the scans feed */
async function moveOwnReceipts(store: StorageBackend, repo: Repo): Promise<number> {
  const from = myStoreFeedId();
  if (!from) return 0;
  let moved = 0;
  for (const row of await store.bySpace('receipt', from)) {
    if (row.deleted !== 0) continue;
    const feedId = await targetFeed(store, row);
    // the feed cannot be registered right now (no network): this receipt waits for the next start
    if (!feedId) continue;
    const newId = movedReceiptId(row.id, !row.instanceId);
    const fields = valuesOf(row as unknown as Held);
    const files = await moveFiles(store, newId, fields);
    // the files before the receipt that names them, and the old row last
    await repo.upsertStamped(feedId, [...files, ...moveWrites(feedId, 'receipt', newId, fields, row.fieldVersions)]);
    await repo.upsertStamped(from, [goneWrite(from, 'receipt', row.id, row.fieldVersions)]);
    moved += 1;
  }
  return moved;
}

/** a space that included one of my connections reads that connection's feed, and its row says which */
async function shareOwnConnections(store: StorageBackend, repo: Repo): Promise<number> {
  const mine = new Set((await store.allRows('storeConn')).filter((c) => c.deleted === 0).map((c) => c.id));
  let shared = 0;
  for (const link of await store.allRows('storeConnLink')) {
    const stamp = link.fieldVersions.instanceId;
    if (link.deleted !== 0 || link.feedSpaceId || !stamp || !mine.has(link.instanceId) || !repo.canWrite(link.spaceId)) continue;
    const feedId = await ensureReceiptFeed(store, link.instanceId);
    if (!feedId) continue;
    try {
      await shareFeed(link.spaceId, feedId);
    } catch {
      continue; // no network, or the space is no longer mine to share with: the next start asks again
    }
    shared += await repo.upsertStamped(link.spaceId, moveWrites(link.spaceId, 'storeConnLink', link.id, { feedSpaceId: feedId }, { feedSpaceId: stamp }));
  }
  return shared;
}

/** what the space decided, under the id a link to that receipt has; the receipt it names is stamped as the copy was born */
function linkWrites(spaceId: string, receiptId: string, feedId: string, link: Held, born: string): Stamped[] {
  const fields = { ...pick(link, LINK_STATE), receiptId, feedSpaceId: feedId };
  const stamps = { ...pick(link.fieldVersions, LINK_STATE), receiptId: born, feedSpaceId: born } as Record<string, string>;
  return moveWrites(spaceId, 'receiptLink', receiptLinkId(spaceId, receiptId), fields, stamps);
}

/** what the copy knew better than the receipt (a read made on the copy), for the receipt itself */
function factsToKeep(receipt: ReceiptRow, link: Held): Stamped[] {
  const held = receipt as unknown as Held;
  const newer = FACTS.filter((name) => {
    const stamp = link.fieldVersions[name];
    if (!(name in link) || !stamp) return false;
    const own = held.fieldVersions[name];
    return (!own || ordinal(stamp, own) > 0) && JSON.stringify(held[name]) !== JSON.stringify(link[name]);
  });
  return moveWrites(receipt.spaceId, 'receipt', receipt.id, pick(link, newer), link.fieldVersions);
}

const holdsPayment = (link: Held): boolean => !!link.txId || !!link.proposedTxId;

type Turn = 'reference' | 'kept' | 'dropped' | 'none';

/** one link in the old shape (it still carries a copy): a reference where its space reads the receipt, else the space's own */
async function turnLink(store: StorageBackend, repo: Repo, link: Held, onlyBorn: boolean): Promise<Turn> {
  const born = link.fieldVersions.source;
  if (link.deleted !== 0 || !born || !repo.canWrite(link.spaceId)) return 'none';
  const spaceId = link.spaceId;
  const oldReceiptId = typeof link.receiptId === 'string' && link.receiptId ? link.receiptId : null;
  // a copy of a receipt that lives elsewhere waits for a copy the server confirmed: what it becomes depends on rows that are not here yet
  if (oldReceiptId && onlyBorn) return 'none';
  const gone = goneWrite(spaceId, 'receiptLink', link.id, link.fieldVersions);

  const receipt = oldReceiptId ? await store.get('receipt', movedReceiptId(oldReceiptId, !link.instanceId)) : undefined;
  if (receipt?.deleted === 0) {
    if ((await includedFeeds(store, spaceId)).has(receipt.spaceId)) {
      const newer = factsToKeep(receipt, link);
      if (newer.length > 0) await repo.upsertStamped(receipt.spaceId, newer);
      await repo.upsertStamped(spaceId, [...linkWrites(spaceId, receipt.id, receipt.spaceId, link, born), gone]);
      return 'reference';
    }
    // the receipt is its owner's and this space does not read it: only what the space shows on a payment is its to keep
    if (!holdsPayment(link)) {
      await repo.upsertStamped(spaceId, [gone]);
      return 'dropped';
    }
  }
  const own = spaceReceiptId(link.id);
  await repo.upsertStamped(spaceId, [
    ...moveWrites(spaceId, 'receipt', own, pick(link, OWN_FACTS), link.fieldVersions),
    ...linkWrites(spaceId, own, spaceId, link, born),
    gone,
  ]);
  return 'kept';
}

/**
 * Every start of the app, after the first sync attempt. A photo taken on a payment becomes its space's own receipt on
 * any copy; everything that depends on where a receipt went waits for a copy the server confirmed in this start.
 */
export async function moveReceiptFeeds(store: StorageBackend, repo: Repo, confirmed: boolean): Promise<number> {
  let changed = 0;
  if (confirmed) {
    changed += await moveOwnReceipts(store, repo);
    changed += await shareOwnConnections(store, repo);
    await shareScansLocally(store, repo);
  }
  for (const link of await store.allRows('receiptLink')) {
    if ((await turnLink(store, repo, link as unknown as Held, !confirmed)) !== 'none') changed += 1;
  }
  return changed;
}
