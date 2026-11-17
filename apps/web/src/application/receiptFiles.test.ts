// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { receiptFileId, receiptLinkId } from '@/domain/feedIds';
import type { ReceiptRow } from '@/db/types';
import { IMAGE_SLOT, copyReceiptFiles, documentSlot, readReceiptFile, splitReceiptFiles, writeReceiptPhoto } from './receiptFiles';
import { writeProposedLinks, writeReceiptLink } from './receiptLinks';

const FEED = 'feed-stores';
const SPACE = 'space-1';
const PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';
const PDF = 'data:application/pdf;base64,JVBERi0=';
let counter = 0;
let backend: DexieBackend;
let repo: Repo;

beforeEach(() => {
  backend = new DexieBackend(new MunniDB(`receipt_files_${++counter}`));
  repo = new Repo(backend, new HlcClock('dev'), { trackOutbox: true });
});

const outboxOf = async (entity: string) => (await backend.outboxAll()).filter((op) => op.entity === entity);

/** a shop receipt in the owner's feed with a photo and two invoices, each a file of its own */
async function seedReceipt(id = 'rcpt:bol:c1:o-1'): Promise<ReceiptRow> {
  const imageId = await writeReceiptPhoto(repo, FEED, id, PHOTO);
  const documents = [0, 1].map((index) => ({ kind: 'invoice' as const, mime: 'application/pdf', filename: `factuur-${index}.pdf`, fileId: receiptFileId(id, documentSlot(index)) }));
  for (const [index, document] of documents.entries()) await repo.upsert('receiptFile', FEED, document.fileId, { ownerId: id, dataUrl: `${PDF}${index}` });
  await repo.upsert('receipt', FEED, id, { source: 'bol', instanceId: 'c1', date: '2026-05-29', totalCents: 15733, merchant: 'bol.com', imageId, documents });
  return (await backend.get('receipt', id))!;
}

describe('what a receipt holds is kept apart from it (#630)', () => {
  it('a photo is a file of its own, named after the row it belongs to: the same on every device', async () => {
    const id = await writeReceiptPhoto(repo, SPACE, 'link-1', PHOTO);

    expect(id).toBe(receiptFileId('link-1', IMAGE_SLOT));
    expect(await backend.get('receiptFile', id)).toMatchObject({ spaceId: SPACE, ownerId: 'link-1', dataUrl: PHOTO, deleted: 0 });
    expect(await readReceiptFile(backend, id)).toBe(PHOTO);
    expect(await readReceiptFile(backend, 'not-here')).toBeNull();
    expect(await readReceiptFile(backend, undefined)).toBeNull();
  });

  it('a link gets its own copies in its space, and the link names those — members never need the owner’s feed', async () => {
    const receipt = await seedReceipt();

    const linkId = await writeReceiptLink(repo, SPACE, receipt, 'pay-1', false);

    const link = (await backend.get('receiptLink', linkId))!;
    expect(link.imageId).toBe(receiptFileId(linkId, IMAGE_SLOT));
    expect(link.documents?.map((d) => d.fileId)).toEqual([0, 1].map((index) => receiptFileId(linkId, documentSlot(index))));
    expect(link.documents?.[1]).toMatchObject({ kind: 'invoice', mime: 'application/pdf', filename: 'factuur-1.pdf' });
    expect(await backend.get('receiptFile', link.imageId!)).toMatchObject({ spaceId: SPACE, ownerId: linkId, dataUrl: PHOTO });
    expect((await backend.get('receiptFile', link.documents![1].fileId))?.dataUrl).toBe(`${PDF}1`);
    // nothing of the content rides the link itself
    expect(JSON.stringify(link)).not.toContain('base64');
  });

  it('a snapshot written again sends no file again; a file that changed is sent', async () => {
    const receipt = await seedReceipt();
    const linkId = await writeReceiptLink(repo, SPACE, receipt, 'pay-1', false);
    await backend.outboxDelete((await backend.outboxAll()).map((op) => op.opId));

    await writeReceiptLink(repo, SPACE, receipt, 'pay-2', false);
    expect(await outboxOf('receiptFile')).toHaveLength(0);

    await repo.upsert('receiptFile', FEED, receipt.documents![0].fileId, { dataUrl: `${PDF}-corrected` });
    await backend.outboxDelete((await backend.outboxAll()).map((op) => op.opId));
    await writeReceiptLink(repo, SPACE, receipt, 'pay-2', false);

    expect((await outboxOf('receiptFile')).map((op) => op.entityId)).toEqual([receiptFileId(linkId, documentSlot(0))]);
    expect((await backend.get('receiptFile', receiptFileId(linkId, documentSlot(0))))?.dataUrl).toBe(`${PDF}-corrected`);
  });

  it('a pass’s proposals carry their files too; a file that has not arrived yet is not invented', async () => {
    const first = await seedReceipt('rcpt:bol:c1:o-1');
    const second = await seedReceipt('rcpt:bol:c1:o-2');
    await backend.deleteRow('receiptFile', second.imageId!);

    await writeProposedLinks(repo, SPACE, [
      { receipt: first, txId: 'pay-1' },
      { receipt: second, txId: 'pay-2' },
    ]);

    const [a, b] = await Promise.all([first, second].map((r) => backend.get('receiptLink', receiptLinkId(SPACE, r.id))));
    expect(a).toMatchObject({ proposedTxId: 'pay-1' });
    expect(await readReceiptFile(backend, a?.imageId)).toBe(PHOTO);
    expect(await readReceiptFile(backend, b?.documents?.[0].fileId)).toBe(`${PDF}0`);
    expect(await readReceiptFile(backend, b?.imageId)).toBeNull();
  });

  it('copying a receipt that holds nothing writes nothing', async () => {
    await repo.upsert('receipt', FEED, 'rcpt:ah:c1:o-9', { source: 'ah', date: '2026-05-29', totalCents: 700 });
    const plain = (await backend.get('receipt', 'rcpt:ah:c1:o-9'))!;

    expect(await copyReceiptFiles(repo, plain, SPACE, 'link-1')).toEqual({ imageId: undefined, documents: undefined });
    expect(await outboxOf('receiptFile')).toHaveLength(0);
  });
});

describe('receipts written before #630 hand what they held to files', () => {
  const OLD = '000000100-0000-devA';
  // rows as the older builds wrote them — the content inside the row — arriving as any change does
  const oldPhotoLink = (id: string, spaceId = SPACE, hlc = OLD) =>
    repo.applyRemoteOps([{ opId: `op-${id}`, spaceId, entity: 'receiptLink', entityId: id, hlc, fields: { txId: 'pay-1', source: 'photo', date: '2026-05-29', totalCents: 1500, image: PHOTO } }]);
  const oldReceipt = (id: string) =>
    repo.applyRemoteOps([
      {
        opId: `op-${id}`,
        spaceId: FEED,
        entity: 'receipt',
        entityId: id,
        hlc: OLD,
        fields: {
          source: 'bol',
          date: '2026-05-29',
          totalCents: 4999,
          documents: [
            { kind: 'invoice', mime: 'application/pdf', filename: 'factuur.pdf', sizeBytes: 5, dataUrl: PDF },
            { kind: 'invoice', mime: 'application/pdf', filename: 'creditnota.pdf', dataUrl: `${PDF}2` },
          ],
        },
      },
    ]);

  it('the photo and every invoice become files; the row keeps what it knew about them and names the files', async () => {
    await oldPhotoLink('link-photo');
    await oldReceipt('rcpt:bol:c1:o-1');

    expect(await splitReceiptFiles(backend, repo)).toBe(5);

    const link = (await backend.get('receiptLink', 'link-photo'))!;
    expect(link.imageId).toBe(receiptFileId('link-photo', IMAGE_SLOT));
    expect((link as unknown as { image: unknown }).image).toBeNull();
    expect(await backend.get('receiptFile', link.imageId!)).toMatchObject({ spaceId: SPACE, ownerId: 'link-photo', dataUrl: PHOTO });
    const receipt = (await backend.get('receipt', 'rcpt:bol:c1:o-1'))!;
    expect(receipt.documents).toEqual([
      { kind: 'invoice', mime: 'application/pdf', filename: 'factuur.pdf', sizeBytes: 5, fileId: receiptFileId('rcpt:bol:c1:o-1', documentSlot(0)) },
      { kind: 'invoice', mime: 'application/pdf', filename: 'creditnota.pdf', fileId: receiptFileId('rcpt:bol:c1:o-1', documentSlot(1)) },
    ]);
    expect(await readReceiptFile(backend, receipt.documents![1].fileId)).toBe(`${PDF}2`);
    expect(JSON.stringify([link, receipt])).not.toContain('base64');
  });

  // the server's ReceiptFileSplitTests pin the same ids and the same stamp for the same rows: a device that pulled the
  // server's changes writes none, and what a device pushes the server already holds
  it('the changes are the ones the server writes: the same ids, stamped right behind the value they replace', async () => {
    await oldPhotoLink('link-photo');
    await oldReceipt('rcpt:bol:c1:o-1');

    await splitReceiptFiles(backend, repo);

    const ops = new Map((await backend.outboxAll()).map((op) => [op.opId, op]));
    expect(ops.get('a6209f0f-03d6-5b0c-bf1a-ca6ca5ff1709')).toMatchObject({
      spaceId: SPACE,
      entity: 'receiptFile',
      entityId: '8c2aa1f8-bcfd-51b6-9912-9ccb6a8eb3e7',
      hlc: `${OLD}~`,
      fields: { ownerId: 'link-photo', dataUrl: PHOTO },
    });
    expect(ops.get('5e2cb7d8-15b7-52b5-9bb2-276f3ba6291c')).toMatchObject({
      entity: 'receiptLink',
      entityId: 'link-photo',
      hlc: `${OLD}~`,
      fields: { image: null, imageId: '8c2aa1f8-bcfd-51b6-9912-9ccb6a8eb3e7' },
    });
    expect(ops.get('9568cdfd-cd6d-533d-8204-93a5b4204dd5')).toMatchObject({ spaceId: FEED, entity: 'receiptFile', entityId: '4999ca75-da96-587d-b1a7-44753c9ca707', hlc: `${OLD}~` });
    expect(ops.get('9a5d84f4-7274-5490-9462-6d31bd5aef30')).toMatchObject({ entity: 'receipt', entityId: 'rcpt:bol:c1:o-1', hlc: `${OLD}~` });
    expect(ops.size).toBe(5);
  });

  it('on a copy that is behind, what another device wrote later still wins', async () => {
    await oldReceipt('rcpt:bol:c1:o-1');
    await splitReceiptFiles(backend, repo);

    // the shop added a third invoice before this device split: that change is newer than the old list, and arrives after
    const newer = [{ kind: 'invoice', mime: 'application/pdf', filename: 'nieuw.pdf', fileId: 'rfile-nieuw' }];
    await repo.applyRemoteOps([{ opId: 'op-newer', spaceId: FEED, entity: 'receipt', entityId: 'rcpt:bol:c1:o-1', hlc: '000000200-0000-server', fields: { documents: newer } }]);

    expect((await backend.get('receipt', 'rcpt:bol:c1:o-1'))?.documents).toEqual(newer);
  });

  it('a removed row is slimmed too — every pass reads it as well — and stays removed', async () => {
    await oldPhotoLink('link-gone');
    await repo.applyRemoteOps([{ opId: 'op-gone', spaceId: SPACE, entity: 'receiptLink', entityId: 'link-gone', hlc: '000000200-0000-devA', fields: {}, deleted: true }]);

    expect(await splitReceiptFiles(backend, repo)).toBe(2);

    const gone = (await backend.get('receiptLink', 'link-gone'))!;
    expect(gone.deleted).toBe(1);
    expect(JSON.stringify(gone)).not.toContain('base64');
    expect(await readReceiptFile(backend, gone.imageId)).toBe(PHOTO);
  });

  it('a second run finds nothing to do, and rows already split are left alone', async () => {
    await oldPhotoLink('link-photo');
    await seedReceipt();
    await splitReceiptFiles(backend, repo);
    await backend.outboxDelete((await backend.outboxAll()).map((op) => op.opId));

    expect(await splitReceiptFiles(backend, repo)).toBe(0);

    expect(await backend.outboxAll()).toHaveLength(0);
  });

  it('a space this person may only read is left to the members who may write it', async () => {
    await oldPhotoLink('link-mine');
    await oldPhotoLink('link-theirs', 'shared');
    const reader = new Repo(backend, new HlcClock('dev'), { trackOutbox: true, readOnly: (spaceId) => spaceId === 'shared' }).upkeep();

    expect(await splitReceiptFiles(backend, reader)).toBe(2);

    expect((await backend.get('receiptLink', 'link-mine'))?.imageId).toBeTruthy();
    expect((await backend.get('receiptLink', 'link-theirs'))?.imageId).toBeUndefined();
  });

  it('a receipt not split yet is split the moment it is linked: the link gets its files, never a name for nothing', async () => {
    await oldReceipt('rcpt:bol:c1:o-1');
    const unsplit = (await backend.get('receipt', 'rcpt:bol:c1:o-1'))!;

    const linkId = await writeReceiptLink(repo, SPACE, unsplit, 'pay-1', false);

    const link = (await backend.get('receiptLink', linkId))!;
    expect(link.documents?.map((d) => d.filename)).toEqual(['factuur.pdf', 'creditnota.pdf']);
    expect(await readReceiptFile(backend, link.documents?.[0].fileId)).toBe(PDF);
    expect(await readReceiptFile(backend, link.documents?.[1].fileId)).toBe(`${PDF}2`);
    expect(JSON.stringify([link, await backend.get('receipt', 'rcpt:bol:c1:o-1')])).not.toContain('base64');
  });
});
