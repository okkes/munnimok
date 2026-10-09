// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { receiptLinkId, storeConnLinkId } from '@/domain/feedIds';
import { acceptProposal, rejectProposal } from './receiptLinks';
import {
  createMatchScheduler,
  includedSpaces,
  matchInputFingerprint,
  matchReceiptsIntoSpace,
  reevaluateSpace,
  rematchSpace,
  rematchSpaces,
  requestReceiptMatching,
} from './receiptMatching';

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
  it('a clear match on a transaction still to review is PROPOSED, never attached by itself (user rule 2026-10-05) — the review card asks', async () => {
    await seedTx('tx-ah', 'Albert Heijn', 1);
    await seedReceipt('t-100');
    const outcome = await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts());
    expect(outcome).toEqual({ linked: 0, proposed: 1 });
    const link = await backend.get('receiptLink', receiptLinkId(SPACE, `rcpt:ah:${CONN}:t-100`));
    expect(link).toMatchObject({ proposedTxId: 'tx-ah', auto: 0, receiptId: `rcpt:ah:${CONN}:t-100` });
    expect(link?.txId).toBeFalsy();
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

  it('never asks twice about one transaction: a second receipt that fits the same row waits', async () => {
    await seedTx('tx-one', 'Albert Heijn', 1);
    await seedReceipt('t-300');
    await seedReceipt('t-301');
    const outcome = await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts());
    expect(outcome.proposed).toBe(1);
    const links = (await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId === 'tx-one');
    expect(links).toHaveLength(1);
  });

  it('a transaction holding a receipt as one of several (user 2026-10-08) is spoken for: no other receipt is proposed for it', async () => {
    await seedTx('tx-first', 'Albert Heijn', 0, { date: '2026-07-04' });
    await seedTx('tx-held', 'Albert Heijn', 1);
    await seedReceipt('t-500');
    const sharedId = `rcpt:ah:${CONN}:t-500`;
    await repo.upsert('receiptLink', SPACE, receiptLinkId(SPACE, sharedId), {
      receiptId: sharedId,
      source: 'ah',
      instanceId: CONN,
      date: '2026-07-05',
      totalCents: 2350,
      merchant: 'Albert Heijn',
      txId: 'tx-first',
      alsoTxIds: ['tx-held'],
      auto: 0,
    });
    // a second receipt that fits tx-held to the cent finds it taken
    await seedReceipt('t-501');
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });
    expect((await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId)).toHaveLength(0);
  });

  it('reevaluateSpace walks every store feed and narrows to one connection', async () => {
    await seedTx('tx-a', 'Albert Heijn', 1);
    await seedReceipt('t-400');
    await seedReceipt('t-401', 'conn-other');
    expect(await reevaluateSpace(backend, repo, SPACE, 'conn-other')).toEqual({ linked: 0, proposed: 1 });
    const proposed = (await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId);
    expect(proposed.map((l) => l.instanceId)).toEqual(['conn-other']);
    expect(await includedSpaces(backend, CONN)).toEqual([SPACE]);
  });
});

describe('the upfront pass (user 2026-10-09: proposals before the review opens)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('rematchSpace reads only the receipts of the connections the space includes; rematchSpaces walks every space with one', async () => {
    await seedTx('tx-inc', 'Albert Heijn', 0);
    await seedReceipt('t-600');
    await seedReceipt('t-601', 'conn-other'); // in the feed, included nowhere yet
    expect(await rematchSpace(backend, repo, SPACE)).toEqual({ linked: 0, proposed: 1 });
    expect((await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId).map((l) => l.instanceId)).toEqual([CONN]);
    // a space without a shop has nothing to match; one that includes the other connection meets its receipt on the walk
    await repo.upsert('space', 's2', 's2', { name: 'Two', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('transaction', 's2', 'tx-s2', { accountId: 'a2', date: '2026-07-05', amountCents: -2350, currency: 'EUR', merchant: 'Albert Heijn', needsReview: 0 });
    expect(await rematchSpace(backend, repo, 's2')).toEqual({ linked: 0, proposed: 0 });
    await repo.upsert('storeConnLink', 's2', storeConnLinkId('s2', 'conn-other'), { instanceId: 'conn-other', store: 'ah', displayName: 'Albert Heijn 2' });
    expect(await rematchSpaces(backend, repo)).toEqual({ linked: 0, proposed: 1 });
    expect((await backend.bySpace('receiptLink', 's2')).map((l) => [l.instanceId, l.proposedTxId])).toEqual([['conn-other', 'tx-s2']]);
    // named spaces narrow the walk
    expect(await rematchSpaces(backend, repo, [SPACE])).toEqual({ linked: 0, proposed: 0 });
  });

  it('the fingerprint moves with the rows the matcher reads and with the gates, never with its own proposals', async () => {
    const before = await matchInputFingerprint(backend);
    await seedTx('tx-fp', 'Albert Heijn', 1);
    const withTx = await matchInputFingerprint(backend);
    expect(withTx).not.toBe(before);
    await seedReceipt('t-700');
    const withReceipt = await matchInputFingerprint(backend);
    expect(withReceipt).not.toBe(withTx);
    expect(await rematchSpace(backend, repo, SPACE)).toEqual({ linked: 0, proposed: 1 });
    expect(await matchInputFingerprint(backend)).toBe(withReceipt);
    await repo.upsert('space', SPACE, SPACE, { historyStartDate: '2026-01-01' });
    expect(await matchInputFingerprint(backend)).not.toBe(withReceipt);
  });

  it('the scheduler folds asks into one pass at idle time, serves an ask that lands mid-pass with one more, and drops a waiting one on dispose', async () => {
    const runs: (readonly string[] | undefined)[] = [];
    let release: () => void = () => undefined;
    const scheduler = createMatchScheduler(
      async (spaceIds) => {
        runs.push(spaceIds);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      { delayMs: 5, idle: (callback) => callback() },
    );
    scheduler.request('s1');
    scheduler.request('s2');
    scheduler.request('s1');
    await sleep(25);
    expect(runs).toEqual([['s1', 's2']]);
    // mid-pass: the ask for everything waits for the running pass and follows it as one more
    scheduler.request();
    scheduler.request('s9');
    await sleep(25);
    expect(runs).toHaveLength(1);
    release();
    await sleep(25);
    expect(runs).toEqual([['s1', 's2'], undefined]);
    release();
    await scheduler.settled();
    // a waiting ask dies with the scheduler; nothing installed = a landing point's ask is a no-op
    scheduler.request('s3');
    scheduler.dispose();
    await scheduler.settled();
    await sleep(25);
    expect(runs).toHaveLength(2);
    expect(() => requestReceiptMatching('s1')).not.toThrow();
  });
});
