// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { receiptLinkId, storeConnLinkId } from '@/domain/feedIds';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import { writeReceiptPhoto } from './receiptFiles';
import {
  attachReceiptTo,
  detachReceiptFrom,
  includedFeeds,
  isLinkedTo,
  linkAsEntry,
  linkedTxIds,
  receiptsInSpace,
  rejectProposal,
  releaseLink,
  spaceReceipts,
  writeProposedLink,
  writeReceiptLink,
} from './receiptLinks';

const FEED = 'feed-bol';
const SPACE = 's1';
const RECEIPT = 'rcp2:bol:conn-bol:o-1';
let counter = 0;
let db: MunniDB;
let repo: Repo;
let backend: DexieBackend;

const seedReceipt = async (id = RECEIPT, spaceId = FEED, date = '2026-05-29'): Promise<ReceiptRow> => {
  await repo.upsert('receipt', spaceId, id, { source: 'bol', instanceId: 'conn-bol', date, totalCents: 15733, merchant: 'bol.com' });
  return (await backend.get('receipt', id))!;
};

const link = async (): Promise<ReceiptLinkRow> => (await backend.get('receiptLink', receiptLinkId(SPACE, RECEIPT)))!;

/** a photo taken on a payment: the space's own receipt, tied to the payment by a link */
const seedOwnPhoto = async (txId: string, alsoTxIds?: string[]): Promise<{ receiptId: string; linkId: string; imageId: string }> => {
  const receiptId = repo.newId();
  const imageId = await writeReceiptPhoto(repo, SPACE, receiptId, 'data:image/jpeg;base64,ZmFrZQ==');
  await repo.upsert('receipt', SPACE, receiptId, { source: 'photo', date: '2026-05-29', totalCents: 1500, imageId });
  const linkId = await writeReceiptLink(repo, SPACE, { id: receiptId, spaceId: SPACE }, txId, false);
  if (alsoTxIds) await repo.upsert('receiptLink', SPACE, linkId, { alsoTxIds });
  return { receiptId, linkId, imageId };
};

beforeEach(async () => {
  db = new MunniDB(`receipt_links_${++counter}`);
  backend = new DexieBackend(db);
  repo = new Repo(backend, new HlcClock('dev'), { trackOutbox: false });
});

describe('one receipt, several transactions (user 2026-10-08)', () => {
  it('linkedTxIds: the first attachment leads, the others follow — twins and empties dropped, nothing without a txId', () => {
    expect(linkedTxIds({ txId: 'a', alsoTxIds: ['b', 'a', '', 'c'] })).toEqual(['a', 'b', 'c']);
    expect(linkedTxIds({ txId: 'a' })).toEqual(['a']);
    expect(linkedTxIds({ alsoTxIds: ['b'] })).toEqual([]);
    expect(isLinkedTo({ txId: 'a', alsoTxIds: ['b'] }, 'b')).toBe(true);
    expect(isLinkedTo({ txId: 'a' }, 'b')).toBe(false);
  });

  it('attaching: the first transaction writes a link naming the receipt and where it lives, a second joins alsoTxIds, the same one again changes nothing', async () => {
    const receipt = await seedReceipt();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    expect(await link()).toMatchObject({ receiptId: RECEIPT, feedSpaceId: FEED, txId: 'pay-1', auto: 0 });
    expect(linkedTxIds(await link())).toEqual(['pay-1']);

    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    expect(await link()).toMatchObject({ txId: 'pay-1', alsoTxIds: ['pay-2'] });
    const before = await link();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    expect(await link()).toEqual(before);
    const [linked] = await spaceReceipts(backend, SPACE);
    expect(linkAsEntry(linked)).toMatchObject({ kind: 'link', txId: 'pay-1', txIds: ['pay-1', 'pay-2'], data: { id: RECEIPT, merchant: 'bol.com' } });
  });

  it('attaching settles a proposal: the receipt is attached to the transaction, the question is gone', async () => {
    const receipt = await seedReceipt();
    await writeProposedLink(repo, SPACE, receipt, 'pay-1');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    const row = await link();
    expect(row.txId).toBe('pay-2');
    expect(row.proposedTxId).toBeFalsy();
    expect(linkedTxIds(row)).toEqual(['pay-2']);
  });

  it('detaching: the first leaving promotes the next; the last leaving leaves the receipt unattached, remembering every transaction it was taken off (#496); a stranger changes nothing', async () => {
    const receipt = await seedReceipt();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-3');

    const untouched = await link();
    await detachReceiptFrom(repo, SPACE, untouched, 'pay-9');
    expect(await link()).toEqual(untouched);

    await detachReceiptFrom(repo, SPACE, await link(), 'pay-1');
    expect(await link()).toMatchObject({ txId: 'pay-2', alsoTxIds: ['pay-3'], rejectedTxIds: ['pay-1'], deleted: 0 });

    await detachReceiptFrom(repo, SPACE, await link(), 'pay-3');
    expect((await link()).txId).toBe('pay-2');
    expect((await link()).alsoTxIds).toBeFalsy();

    await detachReceiptFrom(repo, SPACE, await link(), 'pay-2');
    const left = await link();
    expect(left.deleted).toBe(0);
    expect(linkedTxIds(left)).toEqual([]);
    expect(left.rejectedTxIds).toEqual(['pay-1', 'pay-3', 'pay-2']);
    expect((await backend.get('receipt', RECEIPT))?.deleted).toBe(0);
  });

  it('releasing a whole link (#496): a feed receipt stays unattached and turned down for each of its transactions; the space own photo goes, link and receipt', async () => {
    const receipt = await seedReceipt();
    await writeProposedLink(repo, SPACE, receipt, 'pay-0');
    await rejectProposal(repo, SPACE, await link());
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    await releaseLink(repo, SPACE, await link(), ['pay-1', 'pay-2']);
    expect(await link()).toMatchObject({ deleted: 0, rejectedTxIds: ['pay-0', 'pay-1', 'pay-2'] });
    expect((await link()).txId).toBeFalsy();
    expect((await link()).proposedTxId).toBeFalsy();
    expect((await backend.get('receipt', RECEIPT))?.deleted).toBe(0);

    const photo = await seedOwnPhoto('pay-1');
    await releaseLink(repo, SPACE, (await backend.get('receiptLink', photo.linkId))!, ['pay-1']);
    expect((await backend.get('receiptLink', photo.linkId))?.deleted).toBe(1);
    expect((await backend.get('receipt', photo.receiptId))?.deleted).toBe(1);
  });

  it('a removed photo that an edit made elsewhere brings back still has its picture (#630)', async () => {
    const photo = await seedOwnPhoto('pay-1');
    await releaseLink(repo, SPACE, (await backend.get('receiptLink', photo.linkId))!, ['pay-1']);

    // another device read the photo's lines while this one removed it: the later write wins, the row is back
    await repo.upsert('receipt', SPACE, photo.receiptId, { items: [{ name: 'Brood', totalCents: 1500 }] });

    expect(await backend.get('receipt', photo.receiptId)).toMatchObject({ deleted: 0, imageId: photo.imageId });
    expect(await backend.get('receiptFile', photo.imageId)).toMatchObject({ deleted: 0, dataUrl: 'data:image/jpeg;base64,ZmFrZQ==' });
  });

  it('the space own receipt and its link go with its last transaction, and remember no rejected ones on the way', async () => {
    const photo = await seedOwnPhoto('pay-1', ['pay-2']);
    await detachReceiptFrom(repo, SPACE, (await backend.get('receiptLink', photo.linkId))!, 'pay-2');
    const kept = await backend.get('receiptLink', photo.linkId);
    expect(kept).toMatchObject({ txId: 'pay-1', deleted: 0 });
    expect(kept?.rejectedTxIds).toBeFalsy();
    await detachReceiptFrom(repo, SPACE, kept!, 'pay-1');
    expect((await backend.get('receiptLink', photo.linkId))?.deleted).toBe(1);
    expect((await backend.get('receipt', photo.receiptId))?.deleted).toBe(1);
  });

  it('a re-link after a remove starts clean: the revived tombstone keeps none of its old attachments', async () => {
    const receipt = await seedReceipt();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    await repo.remove('receiptLink', SPACE, receiptLinkId(SPACE, RECEIPT));
    await attachReceiptTo(repo, SPACE, receipt, 'pay-3');
    const row = await link();
    expect(row.deleted).toBe(0);
    expect(linkedTxIds(row)).toEqual(['pay-3']);
  });
});

describe('a link names a receipt that lives once (#648)', () => {
  it('a link is read with the receipt it names; one whose receipt is gone or not here shows nothing', async () => {
    const receipt = await seedReceipt();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    await writeReceiptLink(repo, SPACE, { id: 'rcp2:bol:conn-bol:never-here', spaceId: FEED }, 'pay-2', false);
    expect((await spaceReceipts(backend, SPACE)).map((l) => [l.receiptId, l.merchant, l.totalCents])).toEqual([[RECEIPT, 'bol.com', 15733]]);

    await repo.upsert('receipt', FEED, RECEIPT, { merchant: 'bol' });
    expect((await spaceReceipts(backend, SPACE))[0].merchant).toBe('bol');

    await repo.remove('receipt', FEED, RECEIPT);
    expect(await spaceReceipts(backend, SPACE)).toEqual([]);
  });

  it('a space uses its own receipts and those of the feeds it reads, newest first — a feed it does not read stays out', async () => {
    await seedReceipt('rcp2:bol:conn-bol:o-old', FEED, '2026-05-01');
    await seedReceipt('rcp2:bol:conn-bol:o-new', FEED, '2026-05-20');
    await seedReceipt('rcp2:bol:other:o-1', 'feed-other', '2026-05-25');
    await seedReceipt('own-photo', SPACE, '2026-05-10');
    await seedReceipt('gone', FEED, '2026-05-28');
    await repo.remove('receipt', FEED, 'gone');
    expect((await receiptsInSpace(backend, SPACE)).map((r) => r.id)).toEqual(['own-photo']);

    await repo.upsert('storeConnLink', SPACE, storeConnLinkId(SPACE, 'conn-bol'), { instanceId: 'conn-bol', store: 'bol', displayName: 'bol', feedSpaceId: FEED });
    // a row written before feeds were shared names no feed: it gives the space nothing to read
    await repo.upsert('storeConnLink', SPACE, storeConnLinkId(SPACE, 'conn-other'), { instanceId: 'conn-other', store: 'bol', displayName: 'other' });
    expect([...(await includedFeeds(backend, SPACE)).keys()]).toEqual([FEED]);
    expect((await receiptsInSpace(backend, SPACE)).map((r) => r.id)).toEqual(['rcp2:bol:conn-bol:o-new', 'own-photo', 'rcp2:bol:conn-bol:o-old']);

    await repo.remove('storeConnLink', SPACE, storeConnLinkId(SPACE, 'conn-bol'));
    expect((await receiptsInSpace(backend, SPACE)).map((r) => r.id)).toEqual(['own-photo']);
  });
});
