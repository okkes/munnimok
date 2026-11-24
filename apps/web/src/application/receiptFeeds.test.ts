// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { movedReceiptId, receiptFeedId, receiptFileId, receiptLinkId, scansFeedId, spaceReceiptId, storeConnLinkId, storeFeedId } from '@/domain/feedIds';
import { goneWrite, moveReceiptFeeds, moveWrites } from './receiptFeeds';
import { DEMO_SCANS_FEED_ID, DEMO_STORE_FEED_ID, demoReceiptFeedId } from './storeFeed';

const calls = vi.hoisted(() => ({ api: [] as { path: string; method?: string; body?: string }[], offline: false }));
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  apiFetch: vi.fn(async (path: string, init?: { method?: string; body?: string }) => {
    if (calls.offline) throw new TypeError('offline');
    calls.api.push({ path, method: init?.method, body: init?.body });
    return new Response('{}', { status: 200 });
  }),
}));

const SUB = 'anna';
const STORES = storeFeedId(SUB);
const SHOP_FEED = receiptFeedId('conn-1', SUB);
const SCANS_FEED = scansFeedId(SUB);
const HOME = 'space-home';
const FETCHED = 'rcpt:shop:conn-1:o-1';
const NEW_FETCHED = 'rcp2:shop:conn-1:o-1';
const SCAN = '5b1f6c1e-0000-4000-8000-000000000001';
const NEW_SCAN = `scan:${SCAN}`;
const T1 = '000000100-0000-devA';
const T2 = '000000200-0000-devA';
const T3 = '000000300-0000-devA';
const PDF = 'data:application/pdf;base64,JVBERi0=';
const PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';

let counter = 0;
let backend: DexieBackend;
let repo: Repo;

const signIn = (identity: object) => localStorage.setItem('munni_session', JSON.stringify(identity));

beforeEach(() => {
  backend = new DexieBackend(new MunniDB(`receipt_feeds_${++counter}`));
  repo = new Repo(backend, new HlcClock('dev'), { trackOutbox: true, readOnly: (spaceId) => spaceId === 'space-read-only' });
  calls.api.length = 0;
  calls.offline = false;
  signIn({ kind: 'user', sub: SUB });
});
afterEach(() => localStorage.removeItem('munni_session'));

/** a row as an earlier build (or the server) wrote it, arriving as any change does */
const row = (spaceId: string, entity: string, entityId: string, fields: Record<string, unknown>, hlc = T1, deleted = false) =>
  repo.applyRemoteOps([{ opId: `op-${entity}-${entityId}-${hlc}`, spaceId, entity, entityId, hlc, fields, ...(deleted ? { deleted: true } : {}) }]);

const space = (id: string) => row(id, 'space', id, { name: id, kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });

async function fetched() {
  const invoice = receiptFileId(FETCHED, 'doc:0');
  await row(STORES, 'receiptFile', invoice, { ownerId: FETCHED, dataUrl: PDF });
  await row(STORES, 'receipt', FETCHED, {
    source: 'shop',
    instanceId: 'conn-1',
    date: '2026-05-29',
    totalCents: 4999,
    storeRef: 'shop:o-1',
    items: [{ name: 'Lamp', totalCents: 4999 }],
    documents: [{ kind: 'invoice', mime: 'application/pdf', filename: 'invoice.pdf', fileId: invoice }],
  });
}

async function scan() {
  const picture = receiptFileId(SCAN, 'image');
  await row(STORES, 'receiptFile', picture, { ownerId: SCAN, dataUrl: PHOTO });
  await row(STORES, 'receipt', SCAN, { source: 'photo', date: '2026-05-29', totalCents: 0, imageId: picture });
  await row(STORES, 'receipt', SCAN, { totalCents: 1250 }, T2);
}

const connection = () => row(STORES, 'storeConn', 'conn-1', { store: 'shop', displayName: 'Shop', connectedAt: '2026-05-01' });
const includeShop = (spaceId: string) => row(spaceId, 'storeConnLink', storeConnLinkId(spaceId, 'conn-1'), { instanceId: 'conn-1', store: 'shop', displayName: 'Shop' });

/** a link as the app wrote it before: everything the receipt said, copied */
const copy = (spaceId: string, receiptId: string, state: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  row(spaceId, 'receiptLink', receiptLinkId(spaceId, receiptId), { receiptId, source: 'shop', instanceId: 'conn-1', date: '2026-05-29', totalCents: 4999, ...extra, ...state }, T2);

const outbox = async () => new Map((await backend.outboxAll()).map((op) => [op.opId, op]));

describe('the changes are spelled the way the server spells them (ReceiptFeedsTests)', () => {
  it('a move is named by the stamp and the values it carries, a removal by the row’s newest stamp', () => {
    const stamps = { txId: T2, auto: T2, picks: T3 };
    const moves = moveWrites('space-1', 'receiptLink', 'link-1', { txId: 'pay-1', auto: 0, picks: {} }, stamps);

    expect(moves.map((write) => [write.opId, write.hlc, Object.keys(write.fields)])).toEqual([
      ['b12ea12a-6c26-5851-a280-28f8ad7ea01c', `${T2}~`, ['auto', 'txId']],
      ['e9d6b91a-c842-54c8-a592-fe4ec7c8decc', `${T3}~`, ['picks']],
    ]);
    expect(goneWrite('space-1', 'receiptLink', 'link-1', stamps)).toMatchObject({ opId: 'b736aef2-0652-5cd2-8316-f5d6c08190f0', hlc: `${T3}~`, deleted: true });
  });

  it('ids and feeds are the server’s', () => {
    expect(movedReceiptId(FETCHED, false)).toBe(NEW_FETCHED);
    expect(movedReceiptId('abc', true)).toBe('scan:abc');
    expect(spaceReceiptId('link-1')).toBe('srcp:link-1');
    expect(receiptLinkId('space-1', NEW_FETCHED)).toBe('64a8a17f-8050-5789-8124-f7c6daa0d8b3');
    expect(SHOP_FEED).toBe('d2ecd890-3cdb-5335-b9ae-8a92e025be10');
    expect(SCANS_FEED).toBe('5a7af673-f5b9-5f94-aba7-83baaa47a944');
  });
});

describe('#648: receipts leave the one feed that held them all', () => {
  it('a fetched receipt moves to its connection’s feed and a scan to the scans feed, files and all', async () => {
    await fetched();
    await scan();

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    const invoice = receiptFileId(NEW_FETCHED, 'doc:0');
    expect(await backend.get('receipt', NEW_FETCHED)).toMatchObject({
      spaceId: SHOP_FEED,
      totalCents: 4999,
      storeRef: 'shop:o-1',
      documents: [{ filename: 'invoice.pdf', fileId: invoice }],
      deleted: 0,
    });
    expect(await backend.get('receiptFile', invoice)).toMatchObject({ spaceId: SHOP_FEED, ownerId: NEW_FETCHED, dataUrl: PDF });
    // each value right behind the stamp it had: the amount typed later keeps its later stamp
    const moved = (await backend.get('receipt', NEW_SCAN))!;
    expect(moved).toMatchObject({ spaceId: SCANS_FEED, totalCents: 1250, imageId: receiptFileId(NEW_SCAN, 'image') });
    expect(moved.fieldVersions).toMatchObject({ totalCents: `${T2}~`, date: `${T1}~` });
    expect((await backend.get('receiptFile', receiptFileId(NEW_SCAN, 'image')))?.dataUrl).toBe(PHOTO);

    expect((await backend.get('receipt', FETCHED))?.deleted).toBe(1);
    expect((await backend.get('receipt', SCAN))?.deleted).toBe(1);
    // both feeds were registered before anything was written into them
    expect(calls.api.filter((call) => call.path === '/feeds').map((call) => JSON.parse(call.body!).feedSpaceId)).toEqual([SCANS_FEED, SHOP_FEED]);
    // a file is queued before the receipt that names it
    const queued = (await backend.outboxAll()).filter((op) => op.spaceId === SHOP_FEED).map((op) => op.entity);
    expect(queued).toEqual(['receiptFile', 'receipt']);
  });

  it('a space that included my connection reads its feed, and the space’s link becomes a reference', async () => {
    await space(HOME);
    await connection();
    await fetched();
    await includeShop(HOME);
    await copy(HOME, FETCHED, { txId: 'pay-1', auto: 0, rejectedTxIds: ['pay-9'] });
    const old = receiptLinkId(HOME, FETCHED);
    await row(HOME, 'receiptLink', old, { alsoTxIds: ['pay-2'] }, T3);

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    expect(calls.api).toContainEqual({ path: `/spaces/${HOME}/stores`, method: 'POST', body: JSON.stringify({ feedSpaceId: SHOP_FEED }) });
    expect((await backend.get('storeConnLink', storeConnLinkId(HOME, 'conn-1')))?.feedSpaceId).toBe(SHOP_FEED);
    const link = (await backend.get('receiptLink', receiptLinkId(HOME, NEW_FETCHED)))!;
    expect(link).toMatchObject({ receiptId: NEW_FETCHED, feedSpaceId: SHOP_FEED, txId: 'pay-1', alsoTxIds: ['pay-2'], rejectedTxIds: ['pay-9'], deleted: 0 });
    // nothing of the receipt is in the space any more
    expect(Object.keys(link)).not.toEqual(expect.arrayContaining(['source', 'date', 'totalCents']));
    expect(link.fieldVersions).toMatchObject({ txId: `${T2}~`, alsoTxIds: `${T3}~`, receiptId: `${T2}~` });
    expect((await backend.get('receiptLink', old))?.deleted).toBe(1);
    expect(await backend.get('receipt', spaceReceiptId(old))).toBeUndefined();
  });

  it('what a copy knew better than its receipt is kept on the receipt', async () => {
    await space(HOME);
    await scan();
    await row(HOME, 'storeConnLink', storeConnLinkId(HOME, SCANS_FEED), { instanceId: SCANS_FEED, store: 'photo', displayName: '', feedSpaceId: SCANS_FEED });
    await copy(HOME, SCAN, { txId: 'pay-1' }, { source: 'photo', instanceId: undefined });
    // a read made on the copy: its lines and its total were never on the scan itself
    await row(HOME, 'receiptLink', receiptLinkId(HOME, SCAN), { items: [{ name: 'Bread', totalCents: 1310 }], totalCents: 1310 }, T3);

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    const kept = (await backend.get('receipt', NEW_SCAN))!;
    expect(kept).toMatchObject({ totalCents: 1310, items: [{ name: 'Bread', totalCents: 1310 }] });
    // the day the copy repeated is not written again
    expect(kept.fieldVersions.date).toBe(`${T1}~`);
    expect((await backend.get('receiptLink', receiptLinkId(HOME, NEW_SCAN)))?.txId).toBe('pay-1');
  });

  it('a photo taken on a payment becomes its space’s own receipt — on any copy; a copy of a receipt from elsewhere waits for a confirmed one', async () => {
    await space(HOME);
    await row(HOME, 'receiptLink', 'link-photo', { txId: 'pay-3', source: 'photo', date: '2026-06-01', totalCents: 830, merchant: 'Bakery', imageId: 'file-1', auto: 0 });
    await copy(HOME, FETCHED, { txId: 'pay-1' });

    await moveReceiptFeeds(backend, repo.upkeep(), false);

    const own = spaceReceiptId('link-photo');
    expect(await backend.get('receipt', own)).toMatchObject({ spaceId: HOME, source: 'photo', merchant: 'Bakery', totalCents: 830, imageId: 'file-1', deleted: 0 });
    expect(await backend.get('receiptLink', receiptLinkId(HOME, own))).toMatchObject({ receiptId: own, feedSpaceId: HOME, txId: 'pay-3', deleted: 0 });
    expect((await backend.get('receiptLink', 'link-photo'))?.deleted).toBe(1);
    expect((await backend.get('receiptLink', receiptLinkId(HOME, FETCHED)))?.deleted).toBe(0);
    expect(calls.api).toEqual([]);
  });

  it('a link to a receipt its space cannot read is kept only when it is on a payment', async () => {
    await space(HOME);
    // moved by the server already, and this space does not include the shop
    await row(SHOP_FEED, 'receipt', NEW_FETCHED, { source: 'shop', instanceId: 'conn-1', date: '2026-05-29', totalCents: 4999 });
    await row(SHOP_FEED, 'receipt', 'rcp2:shop:conn-1:o-2', { source: 'shop', instanceId: 'conn-1', date: '2026-05-30', totalCents: 700 });
    await copy(HOME, FETCHED, { rejectedTxIds: ['pay-9'] });
    await copy(HOME, 'rcpt:shop:conn-1:o-2', { txId: 'pay-2' }, { totalCents: 700 });

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    expect((await backend.get('receiptLink', receiptLinkId(HOME, FETCHED)))?.deleted).toBe(1);
    expect(await backend.get('receiptLink', receiptLinkId(HOME, NEW_FETCHED))).toBeUndefined();
    const own = spaceReceiptId(receiptLinkId(HOME, 'rcpt:shop:conn-1:o-2'));
    expect(await backend.get('receipt', own)).toMatchObject({ spaceId: HOME, source: 'shop', totalCents: 700 });
    expect(await backend.get('receiptLink', receiptLinkId(HOME, own))).toMatchObject({ txId: 'pay-2', feedSpaceId: HOME });
  });

  it('a device that held a newer value writes it beside what the server wrote', async () => {
    await space(HOME);
    await row(SHOP_FEED, 'receipt', NEW_FETCHED, { source: 'shop', instanceId: 'conn-1', date: '2026-05-29', totalCents: 4999 });
    await row(HOME, 'storeConnLink', storeConnLinkId(HOME, 'conn-1'), { instanceId: 'conn-1', store: 'shop', displayName: 'Shop', feedSpaceId: SHOP_FEED });
    const old = receiptLinkId(HOME, FETCHED);
    await copy(HOME, FETCHED, { proposedTxId: 'pay-1' });
    // the server turned the link as it knew it: a proposal
    const server = moveWrites(HOME, 'receiptLink', receiptLinkId(HOME, NEW_FETCHED), { receiptId: NEW_FETCHED, feedSpaceId: SHOP_FEED, proposedTxId: 'pay-1' }, { receiptId: T2, feedSpaceId: T2, proposedTxId: T2 });
    await repo.applyRemoteOps(server.map((write) => ({ opId: write.opId!, spaceId: HOME, entity: write.entity, entityId: write.entityId, hlc: write.hlc, fields: write.fields })));
    await row(HOME, 'receiptLink', old, {}, `${T2}~`, true);
    // meanwhile this device had accepted it, and never told anyone
    await row(HOME, 'receiptLink', old, { txId: 'pay-1', proposedTxId: null }, T3);
    expect((await backend.get('receiptLink', old))?.deleted).toBe(0);

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    expect(await backend.get('receiptLink', receiptLinkId(HOME, NEW_FETCHED))).toMatchObject({ txId: 'pay-1', proposedTxId: null, deleted: 0 });
    expect((await backend.get('receiptLink', old))?.deleted).toBe(1);
    // only what the server did not have is queued: the acceptance and the removal behind it
    expect([...(await outbox()).values()].map((op) => [op.entityId, op.hlc, op.deleted === true])).toEqual([
      [receiptLinkId(HOME, NEW_FETCHED), `${T3}~`, false],
      [old, `${T3}~`, true],
    ]);
  });

  it('a second run finds nothing to do, and a space this person only reads is left to those who may write it', async () => {
    await space(HOME);
    await connection();
    await fetched();
    await includeShop(HOME);
    await copy(HOME, FETCHED, { txId: 'pay-1' });
    await row('space-read-only', 'receiptLink', 'link-theirs', { txId: 'pay-5', source: 'photo', date: '2026-06-01', totalCents: 100 });

    expect(await moveReceiptFeeds(backend, repo.upkeep(), true)).toBeGreaterThan(0);
    const queued = (await backend.outboxAll()).length;

    expect(await moveReceiptFeeds(backend, repo.upkeep(), true)).toBe(0);
    expect(await backend.outboxAll()).toHaveLength(queued);
    expect((await backend.get('receiptLink', 'link-theirs'))?.deleted).toBe(0);
    expect(await backend.get('receipt', spaceReceiptId('link-theirs'))).toBeUndefined();
  });

  it('without a network a receipt waits where it is: its feed cannot be registered yet', async () => {
    await fetched();
    calls.offline = true;

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    expect((await backend.get('receipt', FETCHED))?.deleted).toBe(0);
    expect(await backend.get('receipt', NEW_FETCHED)).toBeUndefined();
  });

  it('an identity that never syncs moves its own rows without asking anyone, and its scans are read by every space it has', async () => {
    signIn({ kind: 'demo' });
    await space(HOME);
    await row(DEMO_STORE_FEED_ID, 'storeConn', 'conn-1', { store: 'shop', displayName: 'Shop', connectedAt: '2026-05-01' });
    await row(DEMO_STORE_FEED_ID, 'receipt', FETCHED, { source: 'shop', instanceId: 'conn-1', date: '2026-05-29', totalCents: 4999 });
    await row(DEMO_STORE_FEED_ID, 'receipt', SCAN, { source: 'photo', date: '2026-05-29', totalCents: 1250 });
    await includeShop(HOME);
    await copy(HOME, FETCHED, { txId: 'pay-1' });

    await moveReceiptFeeds(backend, repo.upkeep(), true);

    expect(calls.api).toEqual([]);
    expect((await backend.get('receipt', NEW_FETCHED))?.spaceId).toBe(demoReceiptFeedId('conn-1'));
    expect((await backend.get('receipt', NEW_SCAN))?.spaceId).toBe(DEMO_SCANS_FEED_ID);
    expect((await backend.get('storeConnLink', storeConnLinkId(HOME, 'conn-1')))?.feedSpaceId).toBe(demoReceiptFeedId('conn-1'));
    expect(await backend.get('storeConnLink', storeConnLinkId(HOME, DEMO_SCANS_FEED_ID))).toMatchObject({ store: 'photo', feedSpaceId: DEMO_SCANS_FEED_ID });
    expect(await backend.get('receiptLink', receiptLinkId(HOME, NEW_FETCHED))).toMatchObject({ txId: 'pay-1', feedSpaceId: demoReceiptFeedId('conn-1') });
  });
});
