// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { receiptLinkId, storeConnLinkId } from '@/domain/feedIds';
import { acceptProposal, rejectProposal } from './receiptLinks';
import { includedSpaces, matchReceiptsIntoSpace, reevaluateSpace } from './receiptMatching';

const FEED = 'feed-stores';
const SPACE = 's1';
const CONN = 'conn-ah-1';
let counter = 0;
let db: MunniDB;
let repo: Repo;
let backend: DexieBackend;

const seedTx = (id: string, merchant: string, needsReview: 0 | 1, extra: Record<string, unknown> = {}) =>
  repo.upsert('transaction', SPACE, id, {
    accountId: 'a1',
    date: '2026-07-05',
    amountCents: -2350,
    currency: 'EUR',
    merchant,
    needsReview,
    ...extra,
  });

const seedReceipt = (externalId: string, connectionId = CONN) =>
  repo.upsert('receipt', FEED, `rcpt:ah:${connectionId}:${externalId}`, {
    source: 'ah',
    date: '2026-07-05',
    totalCents: 2350,
    merchant: 'Albert Heijn',
    storeRef: `ah:${externalId}`,
    instanceId: connectionId,
  });

const feedReceipts = async () => (await backend.bySpace('receipt', FEED)).filter((r) => r.deleted === 0);

beforeEach(async () => {
  db = new MunniDB(`receipt_matching_${++counter}`);
  backend = new DexieBackend(db);
  repo = new Repo(backend, new HlcClock('dev'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'One', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('storeConn', FEED, CONN, { store: 'ah', displayName: 'Albert Heijn', connectedAt: '2026-07-01', status: 'ok' });
  await repo.upsert('storeConnLink', SPACE, storeConnLinkId(SPACE, CONN), { instanceId: CONN, store: 'ah', displayName: 'Albert Heijn' });
});

describe('matchReceiptsIntoSpace (#367 §5.7)', () => {
  it('a clear match on a transaction still to review attaches itself', async () => {
    await seedTx('tx-ah', 'Albert Heijn', 1);
    await seedReceipt('t-100');
    const outcome = await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts());
    expect(outcome).toEqual({ linked: 1, proposed: 0 });
    const link = await backend.get('receiptLink', receiptLinkId(SPACE, `rcpt:ah:${CONN}:t-100`));
    expect(link).toMatchObject({ txId: 'tx-ah', auto: 1, receiptId: `rcpt:ah:${CONN}:t-100` });
    // a second pass changes nothing
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });
  });

  it('a reviewed transaction is proposed, never attached behind the human — yes attaches, no forgets it', async () => {
    await seedTx('tx-reviewed', 'Albert Heijn', 0);
    await seedReceipt('t-200');
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 1 });
    const id = receiptLinkId(SPACE, `rcpt:ah:${CONN}:t-200`);
    let link = (await backend.get('receiptLink', id))!;
    expect(link.proposedTxId).toBe('tx-reviewed');
    expect(link.txId).toBeFalsy();
    // the same proposal is not written twice
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });

    await acceptProposal(repo, SPACE, link);
    link = (await backend.get('receiptLink', id))!;
    expect(link.txId).toBe('tx-reviewed');
    expect(link.proposedTxId).toBeFalsy();

    // a rejected transaction is never proposed again for this receipt
    await repo.upsert('receiptLink', SPACE, id, { txId: null as never, proposedTxId: 'tx-reviewed' });
    await rejectProposal(repo, SPACE, (await backend.get('receiptLink', id))!);
    link = (await backend.get('receiptLink', id))!;
    expect(link.rejectedTxIds).toEqual(['tx-reviewed']);
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });
    expect((await backend.get('receiptLink', id))!.proposedTxId).toBeFalsy();
  });

  it('never double-books a transaction that already carries a receipt', async () => {
    await seedTx('tx-one', 'Albert Heijn', 1);
    await seedReceipt('t-300');
    await seedReceipt('t-301');
    const outcome = await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts());
    expect(outcome.linked).toBe(1);
    const links = (await backend.bySpace('receiptLink', SPACE)).filter((l) => l.txId === 'tx-one');
    expect(links).toHaveLength(1);
  });

  it('reevaluateSpace walks every store feed and narrows to one connection', async () => {
    await seedTx('tx-a', 'Albert Heijn', 1);
    await seedReceipt('t-400');
    await seedReceipt('t-401', 'conn-other');
    expect(await reevaluateSpace(backend, repo, SPACE, 'conn-other')).toEqual({ linked: 1, proposed: 0 });
    const linked = (await backend.bySpace('receiptLink', SPACE)).filter((l) => l.txId);
    expect(linked.map((l) => l.instanceId)).toEqual(['conn-other']);
    expect(await includedSpaces(backend, CONN)).toEqual([SPACE]);
  });
});
