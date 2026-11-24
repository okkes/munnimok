// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import type { ReceiptItem, ReceiptRow } from '@/db/types';
import { DEMO_SCANS_FEED_ID, DEMO_STORE_FEED_ID, demoReceiptFeedId } from './storeFeed';
import { MAX_NAMES, categoriseReceipts, handedOverSince } from './receiptCategorise';
import type { AskCategories } from './receiptCategorise';

const AH = demoReceiptFeedId('conn-ah');
const JUMBO = demoReceiptFeedId('conn-jumbo');
/** a feed somebody else owns that this identity only reads */
const THEIRS = 'feed-theirs';

let store: DexieBackend;
let repo: Repo;
/** the seed writes where the owner of each feed would */
let seed: Repo;

beforeEach(async () => {
  // the feeds the categoriser learns from are this identity's own: the demo's are known without a server
  localStorage.setItem('munni_session', JSON.stringify({ kind: 'demo' }));
  store = new DexieBackend(new MunniDB(`munni_categorise_${Math.random().toString(36).slice(2)}`));
  repo = new Repo(store, new HlcClock('categorise'), { trackOutbox: false, readOnly: (spaceId) => spaceId === THEIRS });
  seed = new Repo(store, new HlcClock('seed'), { trackOutbox: false });
  await seed.upsert('storeConn', DEMO_STORE_FEED_ID, 'conn-ah', { store: 'ah', displayName: 'Albert Heijn', connectedAt: '2026-11-01', status: 'ok' });
  await seed.upsert('storeConn', DEMO_STORE_FEED_ID, 'conn-jumbo', { store: 'jumbo', displayName: 'Jumbo', connectedAt: '2026-11-01', status: 'ok' });
});

afterEach(async () => {
  await store.destroy();
  localStorage.removeItem('munni_session');
});

async function receipt(feed: string, id: string, source: string, items: ReceiptItem[], extra: Partial<ReceiptRow> = {}): Promise<ReceiptRow> {
  await seed.upsert('receipt', feed, id, { source, date: '2026-11-02', totalCents: 1000, merchant: source === 'ah' ? 'Albert Heijn' : 'Jumbo', items, ...extra });
  return (await store.get('receipt', id))!;
}

const answering = (byName: Record<string, string | null>) =>
  vi.fn<AskCategories>(async (_merchant, names) => ({ state: 'ok', categories: names.map((name) => byName[name] ?? null), until: null }));

describe('#648: categories for the lines of fetched receipts', () => {
  it('only product lines that have no category yet are asked about, with the shop named; the answers are kept by line name', async () => {
    const row = await receipt(AH, 'r1', 'ah', [
      { name: 'Halfvolle  Melk', totalCents: 129 },
      { name: 'Chocolade', totalCents: 250, catId: 'sweets' },
      { name: 'Statiegeld', totalCents: 25, kind: 'deposit' },
      { name: 'Bonus', totalCents: -50, kind: 'discount' },
      { name: 'Brood', totalCents: 199 },
    ]);
    const ask = answering({ 'Halfvolle  Melk': 'groceryDairy', Brood: 'groceries' });

    const outcome = await categoriseReceipts(store, repo, [row], ask);

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith('Albert Heijn', ['Halfvolle  Melk', 'Brood']);
    expect(outcome).toEqual({ state: 'ok', receipts: 1, more: false });
    expect((await store.get('receipt', 'r1'))?.itemCats).toEqual({ 'halfvolle melk': 'groceryDairy', brood: 'groceries' });
  });

  it('a name the shop’s other receipt was answered for is filled without asking again', async () => {
    await receipt(AH, 'r-old', 'ah', [{ name: 'Melk', totalCents: 129 }], { itemCats: { melk: 'groceryDairy' } });
    const row = await receipt(AH, 'r-new', 'ah', [{ name: 'MELK', totalCents: 129 }]);
    const ask = answering({});

    const outcome = await categoriseReceipts(store, repo, [row], ask);

    expect(ask).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ state: 'ok', receipts: 1 });
    expect((await store.get('receipt', 'r-new'))?.itemCats).toEqual({ melk: 'groceryDairy' });
  });

  it('a name the reader found no category for is remembered as asked, and never sent again', async () => {
    const row = await receipt(AH, 'r1', 'ah', [{ name: 'Cadeaukaart', totalCents: 1000 }]);
    const ask = answering({ Cadeaukaart: null });

    await categoriseReceipts(store, repo, [row], ask);
    expect((await store.get('receipt', 'r1'))?.itemCats).toEqual({ cadeaukaart: '' });

    const again = await categoriseReceipts(store, repo, [(await store.get('receipt', 'r1'))!], ask);
    expect(again).toEqual({ state: 'none', receipts: 0, more: false });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('one shop per call: the other shop waits, and the outcome says there is more', async () => {
    const ah = await receipt(AH, 'r-ah', 'ah', [{ name: 'Melk', totalCents: 129 }]);
    const jumbo = await receipt(JUMBO, 'r-jumbo', 'jumbo', [{ name: 'Kaas', totalCents: 499 }]);
    const ask = answering({ Melk: 'groceryDairy', Kaas: 'groceryDairy' });

    const first = await categoriseReceipts(store, repo, [ah, jumbo], ask);
    expect(first).toEqual({ state: 'ok', receipts: 1, more: true });
    expect(ask).toHaveBeenCalledWith('Albert Heijn', ['Melk']);
    expect((await store.get('receipt', 'r-jumbo'))?.itemCats).toBeUndefined();

    const rows = await Promise.all(['r-ah', 'r-jumbo'].map(async (id) => (await store.get('receipt', id))!));
    const second = await categoriseReceipts(store, repo, rows, ask);
    expect(second).toEqual({ state: 'ok', receipts: 1, more: false });
    expect(ask).toHaveBeenLastCalledWith('Jumbo', ['Kaas']);
  });

  it('more names than one call takes: the first ones are asked, and the outcome says there is more', async () => {
    const items = Array.from({ length: MAX_NAMES + 5 }, (_, n) => ({ name: `Product ${n}`, totalCents: 100 }));
    const row = await receipt(AH, 'r-long', 'ah', items);
    const ask = answering({});

    const outcome = await categoriseReceipts(store, repo, [row], ask);

    expect(ask.mock.calls[0][1]).toHaveLength(MAX_NAMES);
    expect(ask.mock.calls[0][1][0]).toBe('Product 0');
    expect(outcome).toMatchObject({ state: 'ok', receipts: 1, more: true });
    expect(Object.keys((await store.get('receipt', 'r-long'))?.itemCats ?? {})).toHaveLength(MAX_NAMES);
  });

  it('a reader that has done all it may today writes nothing, and says when it is back', async () => {
    const row = await receipt(AH, 'r1', 'ah', [{ name: 'Melk', totalCents: 129 }]);
    const ask = vi.fn<AskCategories>(async () => ({ state: 'limited', categories: null, until: '2026-11-25T00:00:00Z' }));

    const outcome = await categoriseReceipts(store, repo, [row], ask);

    expect(outcome).toEqual({ state: 'limited', receipts: 0, more: true, until: '2026-11-25T00:00:00Z' });
    expect((await store.get('receipt', 'r1'))?.itemCats).toBeUndefined();
  });

  it('a photo (read by its own reader) and a receipt in a feed this identity only reads are left alone', async () => {
    const photo = await receipt(DEMO_SCANS_FEED_ID, 'scan-1', 'photo', [{ name: 'Melk', totalCents: 129 }]);
    const theirs = await receipt(THEIRS, 'r-theirs', 'ah', [{ name: 'Brood', totalCents: 199 }]);
    const ask = answering({ Melk: 'groceryDairy', Brood: 'groceries' });

    expect(await categoriseReceipts(store, repo, [photo, theirs], ask)).toEqual({ state: 'none', receipts: 0, more: false });
    expect(ask).not.toHaveBeenCalled();
  });

  it('a receipt is new by the day its shop handed it over, not by the day of the purchase', async () => {
    const stamped = (id: string, wallMs: number, date: string) =>
      repo.applyRemoteOps([
        { opId: `op-${id}`, spaceId: AH, entity: 'receipt', entityId: id, hlc: `${wallMs.toString(36).padStart(9, '0')}-0000-server`, fields: { source: 'ah', date, totalCents: 100 } },
      ]);
    // bought long ago and handed over today; bought today's date on paper but handed over last month
    await stamped('late', Date.parse('2026-11-24T09:00:00Z'), '2026-10-02');
    await stamped('early', Date.parse('2026-10-20T09:00:00Z'), '2026-11-24');

    const rows = (await store.bySpace('receipt', AH)).filter((row) => row.deleted === 0);

    expect(handedOverSince(rows, '2026-11-24').map((row) => row.id)).toEqual(['late']);
    expect(handedOverSince(rows, '2026-10-01').map((row) => row.id).sort()).toEqual(['early', 'late']);
  });
});
