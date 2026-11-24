// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { receiptLinkId, storeConnLinkId } from '@/domain/feedIds';
import { writeReceiptPhoto } from './receiptFiles';
import { acceptProposal, rejectProposal } from './receiptLinks';
import {
  createMatchScheduler,
  includedSpaces,
  matchInputFingerprint,
  matchReceiptEverywhere,
  matchReceiptsIntoSpace,
  reevaluateSpace,
  rematchSpace,
  rematchSpaces,
  requestReceiptMatching,
} from './receiptMatching';

const SPACE = 's1';
const CONN = 'conn-ah-1';
/** each connection's receipts live in a feed of their own */
const feedOf = (connectionId: string) => `feed-${connectionId}`;
const FEED = feedOf(CONN);
const receiptIdOf = (externalId: string, connectionId = CONN) => `rcp2:ah:${connectionId}:${externalId}`;
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
  repo.upsert('receipt', feedOf(connectionId), receiptIdOf(externalId, connectionId), {
    source: 'ah',
    date: '2026-07-05',
    totalCents: 2350,
    merchant: 'Albert Heijn',
    storeRef: `ah:${externalId}`,
    instanceId: connectionId,
  });

const feedReceipts = async () => (await backend.bySpace('receipt', FEED)).filter((r) => r.deleted === 0);

const includeFeed = (spaceId: string, instanceId: string, feedSpaceId: string, store = 'ah') =>
  repo.upsert('storeConnLink', spaceId, storeConnLinkId(spaceId, instanceId), { instanceId, store, displayName: 'Albert Heijn', feedSpaceId });

beforeEach(async () => {
  db = new MunniDB(`receipt_matching_${++counter}`);
  backend = new DexieBackend(db);
  repo = new Repo(backend, new HlcClock('dev'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'One', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('storeConn', 'feed-stores', CONN, { store: 'ah', displayName: 'Albert Heijn', connectedAt: '2026-07-01', status: 'ok' });
  await includeFeed(SPACE, CONN, FEED);
});

describe('matchReceiptsIntoSpace (#367 §5.7)', () => {
  it('a clear match on a transaction still to review is PROPOSED, never attached by itself (user rule 2026-10-05) — the review card asks', async () => {
    await seedTx('tx-ah', 'Albert Heijn', 1);
    await seedReceipt('t-100');
    const outcome = await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts());
    expect(outcome).toEqual({ linked: 0, proposed: 1 });
    const link = await backend.get('receiptLink', receiptLinkId(SPACE, receiptIdOf('t-100')));
    expect(link).toMatchObject({ proposedTxId: 'tx-ah', auto: 0, receiptId: receiptIdOf('t-100'), feedSpaceId: FEED });
    expect(link?.txId).toBeFalsy();
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });
  });

  it('a reviewed transaction is proposed, never attached behind the human — yes attaches, no forgets it', async () => {
    await seedTx('tx-reviewed', 'Albert Heijn', 0);
    await seedReceipt('t-200');
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 1 });
    const id = receiptLinkId(SPACE, receiptIdOf('t-200'));
    let link = (await backend.get('receiptLink', id))!;
    expect(link.proposedTxId).toBe('tx-reviewed');
    expect(link.txId).toBeFalsy();
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });

    await acceptProposal(repo, SPACE, link);
    link = (await backend.get('receiptLink', id))!;
    expect(link.txId).toBe('tx-reviewed');
    expect(link.proposedTxId).toBeFalsy();

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
    const sharedId = receiptIdOf('t-500');
    await repo.upsert('receiptLink', SPACE, receiptLinkId(SPACE, sharedId), {
      receiptId: sharedId,
      feedSpaceId: FEED,
      txId: 'tx-first',
      alsoTxIds: ['tx-held'],
      auto: 0,
    });
    await seedReceipt('t-501');
    expect(await matchReceiptsIntoSpace(backend, repo, SPACE, await feedReceipts())).toEqual({ linked: 0, proposed: 0 });
    expect((await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId)).toHaveLength(0);
  });

  it('reevaluateSpace walks every feed the space reads and narrows to one feed', async () => {
    await seedTx('tx-a', 'Albert Heijn', 1);
    await seedReceipt('t-400');
    await seedReceipt('t-401', 'conn-other');
    await includeFeed(SPACE, 'conn-other', feedOf('conn-other'));
    expect(await reevaluateSpace(backend, repo, SPACE, feedOf('conn-other'))).toEqual({ linked: 0, proposed: 1 });
    const proposed = (await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId);
    expect(proposed.map((l) => l.feedSpaceId)).toEqual([feedOf('conn-other')]);
    expect(await includedSpaces(backend, CONN)).toEqual([SPACE]);
  });
});

describe('a receipt kept without a transaction (#567)', () => {
  const SCANS = 'feed-scans';
  const photo = async (id: string, fields: Record<string, unknown>) =>
    repo.upsert('receipt', SCANS, id, { source: 'photo', date: '2026-07-04', totalCents: 0, imageId: await writeReceiptPhoto(repo, SCANS, id, 'data:image/jpeg;base64,ZmFrZQ=='), ...fields } as never);

  beforeEach(async () => {
    // a space that includes no shop, but reads the person's scans
    await repo.upsert('space', 's2', 's2', { name: 'No shops', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await includeFeed('s2', SCANS, SCANS, 'photo');
    await repo.upsert('transaction', 's2', 'coffee', { accountId: 'a1', date: '2026-07-05', amountCents: -420, currency: 'EUR', merchant: 'Koffiebar', needsReview: 1 });
  });

  it('a scan is proposed to the payment it fits in a space that reads the scans — once it has an amount, never before', async () => {
    await photo('photo1', {});
    expect((await rematchSpaces(backend, repo)).proposed).toBe(0);

    await photo('photo1', { totalCents: 420 });
    expect((await rematchSpaces(backend, repo)).proposed).toBe(1);
    const link = await backend.get('receiptLink', receiptLinkId('s2', 'photo1'));
    expect(link).toMatchObject({ proposedTxId: 'coffee', receiptId: 'photo1', feedSpaceId: SCANS });
    expect(link?.txId ?? null).toBeNull();
    expect((await rematchSpaces(backend, repo)).proposed).toBe(0);
  });

  it('one scan against every space that reads it, and none that does not; a pass about one feed leaves the scans out; the fingerprint counts them', async () => {
    await repo.upsert('transaction', SPACE, 'coffee-s1', { accountId: 'a1', date: '2026-07-05', amountCents: -420, currency: 'EUR', merchant: 'Koffiebar', needsReview: 1 });
    const before = await matchInputFingerprint(backend);
    await photo('photo2', { totalCents: 420, merchant: 'Koffiebar Centraal' });
    expect(await matchInputFingerprint(backend)).not.toBe(before);

    expect((await reevaluateSpace(backend, repo, 's2', FEED)).proposed).toBe(0);
    const row = (await backend.get('receipt', 'photo2'))!;
    expect((await matchReceiptEverywhere(backend, repo, row)).proposed).toBe(1);
    expect((await backend.get('receiptLink', receiptLinkId('s2', 'photo2')))?.proposedTxId).toBe('coffee');
    expect(await backend.get('receiptLink', receiptLinkId(SPACE, 'photo2'))).toBeUndefined();
  });

  it('a name that fits no payment keeps the photo waiting', async () => {
    await photo('photo3', { totalCents: 420, merchant: 'Bakker Bart' });
    expect((await rematchSpaces(backend, repo)).proposed).toBe(0);
  });
});

describe('the upfront pass (user 2026-10-09: proposals before the review opens)', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it('rematchSpace reads only the receipts of the feeds the space includes; rematchSpaces walks every space with one', async () => {
    await seedTx('tx-inc', 'Albert Heijn', 0);
    await seedReceipt('t-600');
    await seedReceipt('t-601', 'conn-other'); // in the feed, included nowhere yet
    expect(await rematchSpace(backend, repo, SPACE)).toEqual({ linked: 0, proposed: 1 });
    expect((await backend.bySpace('receiptLink', SPACE)).filter((l) => l.proposedTxId).map((l) => l.feedSpaceId)).toEqual([FEED]);
    await repo.upsert('space', 's2', 's2', { name: 'Two', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('transaction', 's2', 'tx-s2', { accountId: 'a2', date: '2026-07-05', amountCents: -2350, currency: 'EUR', merchant: 'Albert Heijn', needsReview: 0 });
    expect(await rematchSpace(backend, repo, 's2')).toEqual({ linked: 0, proposed: 0 });
    await includeFeed('s2', 'conn-other', feedOf('conn-other'));
    expect(await rematchSpaces(backend, repo)).toEqual({ linked: 0, proposed: 1 });
    expect((await backend.bySpace('receiptLink', 's2')).map((l) => [l.feedSpaceId, l.proposedTxId])).toEqual([[feedOf('conn-other'), 'tx-s2']]);
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
    scheduler.request();
    scheduler.request('s9');
    await sleep(25);
    expect(runs).toHaveLength(1);
    release();
    await sleep(25);
    expect(runs).toEqual([['s1', 's2'], undefined]);
    release();
    await scheduler.settled();
    scheduler.request('s3');
    scheduler.dispose();
    await scheduler.settled();
    await sleep(25);
    expect(runs).toHaveLength(2);
    expect(() => requestReceiptMatching('s1')).not.toThrow();
  });
});
