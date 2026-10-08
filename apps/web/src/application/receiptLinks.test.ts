// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { receiptLinkId } from '@/domain/feedIds';
import type { ReceiptLinkRow, ReceiptRow } from '@/db/types';
import { attachReceiptTo, detachReceiptFrom, isLinkedTo, linkAsEntry, linkedTxIds, writeProposedLink } from './receiptLinks';

const FEED = 'feed-stores';
const SPACE = 's1';
const RECEIPT = 'rcpt:bol:conn-bol:o-1';
let counter = 0;
let db: MunniDB;
let repo: Repo;
let backend: DexieBackend;

const seedReceipt = async (id = RECEIPT): Promise<ReceiptRow> => {
  await repo.upsert('receipt', FEED, id, { source: 'bol', instanceId: 'conn-bol', date: '2026-05-29', totalCents: 15733, merchant: 'bol.com' });
  return (await backend.get('receipt', id))!;
};

const link = async (): Promise<ReceiptLinkRow> => (await backend.get('receiptLink', receiptLinkId(SPACE, RECEIPT)))!;

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

  it('attaching: the first transaction writes the snapshot link, a second joins alsoTxIds, the same one again changes nothing', async () => {
    const receipt = await seedReceipt();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    expect(await link()).toMatchObject({ receiptId: RECEIPT, txId: 'pay-1', merchant: 'bol.com', auto: 0 });
    expect(linkedTxIds(await link())).toEqual(['pay-1']);

    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    expect(await link()).toMatchObject({ txId: 'pay-1', alsoTxIds: ['pay-2'] });
    const before = await link();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    expect(await link()).toEqual(before);
    expect(linkAsEntry(await link())).toMatchObject({ kind: 'link', txId: 'pay-1', txIds: ['pay-1', 'pay-2'] });
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

  it('detaching: the first leaving promotes the next, the last leaving removes the link (the store receipt is unmatched again), a stranger changes nothing', async () => {
    const receipt = await seedReceipt();
    await attachReceiptTo(repo, SPACE, receipt, 'pay-1');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-2');
    await attachReceiptTo(repo, SPACE, receipt, 'pay-3');

    const untouched = await link();
    await detachReceiptFrom(repo, SPACE, untouched, 'pay-9');
    expect(await link()).toEqual(untouched);

    await detachReceiptFrom(repo, SPACE, await link(), 'pay-1');
    expect(await link()).toMatchObject({ txId: 'pay-2', alsoTxIds: ['pay-3'], deleted: 0 });

    await detachReceiptFrom(repo, SPACE, await link(), 'pay-3');
    expect((await link()).txId).toBe('pay-2');
    expect((await link()).alsoTxIds).toBeFalsy();

    await detachReceiptFrom(repo, SPACE, await link(), 'pay-2');
    expect((await link()).deleted).toBe(1);
  });

  it('a photo-born link (the photo IS the link) goes with its last transaction', async () => {
    const id = repo.newId();
    await repo.upsert('receiptLink', SPACE, id, { txId: 'pay-1', alsoTxIds: ['pay-2'], source: 'photo', date: '2026-05-29', totalCents: 15733, image: 'data:image/jpeg;base64,ZmFrZQ==' });
    await detachReceiptFrom(repo, SPACE, (await backend.get('receiptLink', id))!, 'pay-2');
    expect(await backend.get('receiptLink', id)).toMatchObject({ txId: 'pay-1', deleted: 0 });
    await detachReceiptFrom(repo, SPACE, (await backend.get('receiptLink', id))!, 'pay-1');
    expect((await backend.get('receiptLink', id))?.deleted).toBe(1);
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
