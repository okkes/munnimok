import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { importOpId, receiptFileId } from '@/domain/feedIds';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import type { ReceiptDocument, ReceiptLinkRow, ReceiptRow } from '@/db/types';

// #630: a receipt's photo and invoices are receiptFile rows of the receipt's own space (the feed it lives in), named by
// the slot they fill; whoever reads the receipt reads them there (#648: a space keeps no copies).
// A file is never removed with its row: an edit made elsewhere can bring a removed row back, and it finds its picture

export const IMAGE_SLOT = 'image';
export const documentSlot = (index: number): string => `doc:${index}`;

/** the photo of a receipt or link that is about to be written; answers the id the row names */
export async function writeReceiptPhoto(repo: Repo, spaceId: string, ownerId: string, dataUrl: string): Promise<string> {
  const id = receiptFileId(ownerId, IMAGE_SLOT);
  await repo.upsert('receiptFile', spaceId, id, { ownerId, dataUrl });
  return id;
}

/** what a file holds; null when it is not (yet) on this device */
export async function readReceiptFile(store: StorageBackend, fileId: string | undefined): Promise<string | null> {
  if (!fileId) return null;
  const file = await store.get('receiptFile', fileId);
  return file?.deleted === 0 ? file.dataUrl : null;
}

/** undefined while it is read */
export function useReceiptFile(fileId: string | undefined): string | null | undefined {
  const { store } = useData();
  return useQuery(store, () => readReceiptFile(store, fileId), [fileId]);
}

/** a row as builds before #630 wrote it: the photo and each invoice inside the row itself */
interface Inline extends Pick<ReceiptRow, 'id' | 'spaceId' | 'fieldVersions'> {
  image?: string | null;
  documents?: (Omit<ReceiptDocument, 'fileId'> & { fileId?: string; dataUrl?: string })[];
}

type Holder = 'receipt' | 'receiptLink';
type Stamped = Parameters<Repo['upsertStamped']>[1][number];

/** the stamp right behind another: it replaces exactly the value that stamp wrote, and loses to every later write */
const behind = (stamp: string): string => `${stamp}~`;

/** the server spells a file's change the same way (ReceiptFileSplit.FileOp): same file, same content, one change */
export async function fileWrite(ownerId: string, fileId: string, dataUrl: string, hlc: string): Promise<Stamped> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(dataUrl)));
  const hash = Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return { entity: 'receiptFile', entityId: fileId, fields: { ownerId, dataUrl }, hlc, opId: importOpId(`rfile:${fileId}:${hash}`) };
}

// What the row still holds itself moves to files, and the row names them. The server does the same to every row it holds
// (ReceiptFileSplit), with the same ids and stamps: a device that pulled that finds nothing to do, one that did not (a
// store that never syncs, a start without a network) does it here, and what it pushes later the server already has.
// Stamped right behind the value it replaces: on a copy that is behind, a newer invoice list still wins
async function splitRow(repo: Repo, entity: Holder, held: ReceiptRow | ReceiptLinkRow): Promise<number> {
  const row: Inline = held;
  const seed = `repair:receipt-files:${row.spaceId}:${entity}:${row.id}`;
  const writes: Stamped[] = [];
  const imageStamp = row.fieldVersions.image;
  if (row.image && imageStamp) {
    const imageId = receiptFileId(row.id, IMAGE_SLOT);
    const hlc = behind(imageStamp);
    // the file first: a row never names a file that is not there
    writes.push(await fileWrite(row.id, imageId, row.image, hlc), { entity, entityId: row.id, fields: { image: null, imageId }, hlc, opId: importOpId(`${seed}:image`) });
  }
  const documentsStamp = row.fieldVersions.documents;
  if (documentsStamp && row.documents?.some((document) => document.dataUrl)) {
    const hlc = behind(documentsStamp);
    const documents = [];
    for (const [index, { dataUrl, ...document }] of row.documents.entries()) {
      if (!dataUrl) {
        documents.push(document);
        continue;
      }
      const fileId = receiptFileId(row.id, documentSlot(index));
      writes.push(await fileWrite(row.id, fileId, dataUrl, hlc));
      documents.push({ ...document, fileId });
    }
    writes.push({ entity, entityId: row.id, fields: { documents }, hlc, opId: importOpId(`${seed}:documents`) });
  }
  return repo.upsertStamped(row.spaceId, writes);
}

/** every start of the app; removed rows too — a pass reads them with the rest before it leaves them out */
export async function splitReceiptFiles(store: StorageBackend, repo: Repo): Promise<number> {
  let changed = 0;
  for (const entity of ['receipt', 'receiptLink'] as const) {
    for (const row of await store.allRows(entity)) changed += await splitRow(repo, entity, row);
  }
  return changed;
}
