// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { visibleAccounts, visibleTransactions } from '@/db/joined';
import { accountLinkId, mirrorTxId, txMetaId } from '@/domain/feedIds';
import { bankRowsOf, entriesOnTopOf, linkEntries, linkEntry, unlinkEntry } from './entryLink';
import { carryReservedOpinions } from './reservedCarry';

const SPACE = 'space_entry';
const OTHER = 'space_other';
const FEED = 'feed_entry';
const ACCOUNT = 'acct_entry';
let counter = 0;
let db: MunniDB;
let store: DexieBackend;
let repo: Repo;

/** a feed row as the ingest writes it */
const feedRow = (id: string, date: string, amountCents: number, merchant: string, pending = false) =>
  repo.upsert('transaction', FEED, id, {
    accountId: ACCOUNT, date, amountCents, currency: 'EUR', merchant, needsReview: 1, ...(pending ? { pending: 1 as const } : {}),
  });

/** what a person typed on the bank account, in the space */
const entry = (id: string, date: string, amountCents: number, merchant: string, more: Record<string, unknown> = {}) =>
  repo.upsert('transaction', SPACE, id, {
    accountId: ACCOUNT, date, amountCents, currency: 'EUR', merchant, needsReview: 0, enteredAt: `${date}T09:00:00.000Z`, inBalance: 1, ...more,
  } as never);

const rowOf = async (id: string) => (await store.get('transaction', id))!;
const metaOf = async (txId: string) => store.get('txMeta', txMetaId(SPACE, txId));
const viewed = async () => (await visibleTransactions(store, SPACE)).sort((a, b) => a.id.localeCompare(b.id));
const bankRef = async (id: string) => ({ raw: await rowOf(id), feedSpaceId: FEED });

/** #547: a hand-typed entry on a bank account, and the bank's own transaction */
describe('your entry and the bank’s transaction read as one', () => {
  beforeEach(async () => {
    db = new MunniDB(`munni_entry_link_${++counter}`);
    store = new DexieBackend(db);
    repo = new Repo(store, new HlcClock('entry'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 } as never);
    await repo.upsert('space', OTHER, OTHER, { name: 'Shared', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 } as never);
    await repo.upsert('account', FEED, ACCOUNT, { name: 'Bank · 9507', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 100_000, balanceAsOf: '2026-11-10' });
    await repo.upsert('accountLink', SPACE, accountLinkId(SPACE, FEED), { feedSpaceId: FEED, accountId: ACCOUNT });
    await repo.upsert('accountLink', OTHER, accountLinkId(OTHER, FEED), { feedSpaceId: FEED, accountId: ACCOUNT });
    await repo.upsert('account', SPACE, 'wallet', { name: 'Wallet', type: 'cash', source: 'manual', currency: 'EUR', balanceCents: 0 });
  });
  afterEach(() => db.close());

  it('the bank’s row arrives: the entry is linked without asking, its story moves onto the row, and the row waits in the review', async () => {
    await entry('e1', '2026-11-10', -1250, 'Lunch at Bagels', { catId: 'restaurants', notes: 'with Sam' });
    expect((await viewed()).map((tx) => tx.id)).toEqual(['e1']);

    await feedRow('b1', '2026-11-11', -1250, 'BAGELS & BEANS AMSTERDAM');
    expect(await linkEntries(store, repo)).toBe(1);

    // one transaction: the bank's facts, the entry's story, and what was typed on the side
    const [only, ...rest] = await viewed();
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ id: 'b1', date: '2026-11-11', merchant: 'BAGELS & BEANS AMSTERDAM', catId: 'restaurants', notes: 'with Sam', needsReview: 1 });
    expect(only.entry).toEqual({ id: 'e1', amountCents: -1250, date: '2026-11-10', title: 'Lunch at Bagels' });
    expect(await rowOf('e1')).toMatchObject({ bankTxId: 'b1', deleted: 0 });
    // a second pass, or another device, links nothing again
    expect(await linkEntries(store, repo)).toBe(0);
    // the other space of this account never hears of the entry
    expect((await visibleTransactions(store, OTHER)).map((tx) => [tx.id, tx.catId, tx.entry])).toEqual([['b1', undefined, undefined]]);
  });

  it('taken apart, both are back: the entry with the story as it stands, the bank’s row as it was — and the pair is not made again', async () => {
    await feedRow('b1', '2026-11-11', -1250, 'BAGELS & BEANS');
    // the review had filed the bank's row before the entry was linked to it by hand
    await repo.upsert('txMeta', SPACE, txMetaId(SPACE, 'b1'), { txId: 'b1', needsReview: 0, catId: 'groceries' } as never);
    await entry('e1', '2026-11-10', -1250, 'Lunch', { catId: 'restaurants' });
    await linkEntry(store, repo, SPACE, await rowOf('e1'), await bankRef('b1'), false);
    // linked by hand: the row keeps its place outside the review
    expect(await metaOf('b1')).toMatchObject({ catId: 'restaurants', needsReview: 0 });
    // the person changes their mind about the category while the two are one
    await repo.upsert('txMeta', SPACE, txMetaId(SPACE, 'b1'), { catId: 'coffee', notes: 'on the way' } as never);

    await unlinkEntry(store, repo, SPACE, await rowOf('e1'), await bankRef('b1'));
    const [bank, mine] = await viewed();
    expect(bank).toMatchObject({ id: 'b1', catId: 'groceries', needsReview: 0 });
    expect(bank.notes ?? null).toBeNull();
    expect(bank.entry).toBeUndefined();
    expect(mine).toMatchObject({ id: 'e1', amountCents: -1250, date: '2026-11-10', merchant: 'Lunch', catId: 'coffee', notes: 'on the way' });
    expect(await rowOf('e1')).toMatchObject({ bankTxId: null, noBankTxIds: ['b1'] });
    expect(await linkEntries(store, repo)).toBe(0);
  });

  it('a different amount: the split is resized to what the bank booked, and comes back sized to what was typed', async () => {
    await feedRow('b1', '2026-11-11', -1500, 'RESTAURANT');
    await entry('e1', '2026-11-10', -1000, 'Dinner', { catId: 'restaurants', cats: [{ catId: 'restaurants', amountCents: 800 }, { catId: 'coffee', amountCents: 200 }] });
    // not the same amount: never linked without asking
    expect(await linkEntries(store, repo)).toBe(0);
    await linkEntry(store, repo, SPACE, await rowOf('e1'), await bankRef('b1'), false);
    expect((await metaOf('b1'))?.cats).toEqual([{ catId: 'restaurants', amountCents: 1200 }, { catId: 'coffee', amountCents: 300 }]);

    await unlinkEntry(store, repo, SPACE, await rowOf('e1'), await bankRef('b1'));
    expect(await rowOf('e1')).toMatchObject({ amountCents: -1000, cats: [{ catId: 'restaurants', amountCents: 800 }, { catId: 'coffee', amountCents: 200 }] });
  });

  it('an entry with a counterparty: one payment moves the other account once, linked or not', async () => {
    await entry('e1', '2026-11-10', -5000, 'ATM');
    const { writeTxTransform } = await import('@/db/joined');
    await writeTxTransform(repo, { id: 'e1', spaceId: SPACE, feedSpaceId: undefined, needsReview: 0 }, { catId: 'cashWithdrawal', linkedAccountId: 'wallet' });
    const walletLegs = async () => (await store.bySpace('transaction', SPACE)).filter((row) => row.deleted === 0 && row.accountId === 'wallet').map((row) => row.id);
    expect(await walletLegs()).toEqual([mirrorTxId('e1')]);

    await feedRow('b1', '2026-11-10', -5000, 'GELDAUTOMAAT 12');
    expect(await linkEntries(store, repo)).toBe(1);
    expect(await walletLegs()).toEqual([mirrorTxId('b1')]);
    expect(await metaOf('b1')).toMatchObject({ linkedAccountId: 'wallet' });

    await unlinkEntry(store, repo, SPACE, await rowOf('e1'), await bankRef('b1'));
    expect(await walletLegs()).toEqual([mirrorTxId('e1')]);
    expect((await rowOf('e1')).linkedAccountId).toBe('wallet');
  });

  it('linked to a reserved amount, the link reaches the booking when the bank replaces it', async () => {
    await feedRow('hold', '2026-11-10', -1250, 'BAGELS & BEANS', true);
    await entry('e1', '2026-11-10', -1250, 'Lunch', { catId: 'restaurants' });
    expect(await linkEntries(store, repo)).toBe(1);
    expect((await rowOf('e1')).bankTxId).toBe('hold');

    await feedRow('booked', '2026-11-12', -1250, 'BAGELS & BEANS');
    await repo.remove('transaction', FEED, 'hold');
    await carryReservedOpinions(store, repo);
    expect(await linkEntries(store, repo)).toBe(0);
    expect((await rowOf('e1')).bankTxId).toBe('booked');
    const rows = await viewed();
    expect(rows.map((tx) => tx.id)).toEqual(['booked']);
    expect(rows[0]).toMatchObject({ catId: 'restaurants', entry: { id: 'e1' } });
  });

  it('a bank row that is gone frees its entry — a hold that never booked once no booking can follow', async () => {
    await feedRow('b1', '2026-11-10', -1250, 'SHOP');
    await entry('e1', '2026-11-10', -1250, 'Shop', { catId: 'groceries' });
    await linkEntries(store, repo);
    await repo.remove('transaction', FEED, 'b1');
    await linkEntries(store, repo);
    expect(await rowOf('e1')).toMatchObject({ bankTxId: null, catId: 'groceries' });
    expect((await viewed()).map((tx) => tx.id)).toEqual(['e1']);

    await feedRow('hold', '2026-11-10', -700, 'PARKING', true);
    await entry('e2', '2026-11-10', -700, 'Parking');
    await linkEntries(store, repo);
    await repo.remove('transaction', FEED, 'hold');
    // still inside the days a booking may follow: the claim stands
    await linkEntries(store, repo);
    expect((await rowOf('e2')).bankTxId).toBe('hold');
    // three weeks on it was released, not booked
    await linkEntries(store, repo, Date.now() + 21 * 86_400_000);
    expect((await rowOf('e2')).bankTxId).toBeNull();
  });

  it('the balance: the bank’s number plus the entries that still count — in this space only', async () => {
    const balances = async (spaceId: string) => {
      const account = (await visibleAccounts(store, spaceId)).find((a) => a.id === ACCOUNT)!;
      return [account.balanceCents, account.bankBalanceCents, account.entriesCents];
    };
    expect(await balances(SPACE)).toEqual([100_000, undefined, undefined]);

    await entry('e1', '2026-11-10', -1250, 'Lunch');
    await entry('e2', '2026-11-11', 5000, 'Tikkie back');
    // typed before the bank's balance: already in its number, the tick is off
    await entry('old', '2026-11-08', -900, 'Old', { inBalance: 0 });
    expect(await balances(SPACE)).toEqual([103_750, 100_000, 3750]);
    expect(await balances(OTHER)).toEqual([100_000, undefined, undefined]);
    // the stored balance is the bank's and stays it
    expect((await store.get('account', ACCOUNT))?.balanceCents).toBe(100_000);

    // booked by the bank: that entry stops counting; a reserved amount is not in the bank's balance yet
    await feedRow('b1', '2026-11-11', -1250, 'BAGELS');
    await feedRow('hold', '2026-11-11', 5000, 'TIKKIE', true);
    expect(await linkEntries(store, repo)).toBe(2);
    expect(await balances(SPACE)).toEqual([105_000, 100_000, 5000]);

    // going offline folds what still counts into the balance: the account is hand-kept from then on
    expect(await entriesOnTopOf(store, (await store.get('account', ACCOUNT))!)).toBe(5000);

    // the bank's balance moved on three days past the entry: it has clearly passed it
    await repo.upsert('account', FEED, ACCOUNT, { balanceCents: 105_000, balanceAsOf: '2026-11-14' });
    expect(await balances(SPACE)).toEqual([105_000, undefined, undefined]);
    expect(await entriesOnTopOf(store, (await store.get('account', ACCOUNT))!)).toBe(0);
  });

  it('bank rows are the feed’s and the ones imported into the space — never another hand-typed entry', async () => {
    await repo.upsert('account', SPACE, 'imported', { name: 'Old bank', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('transaction', SPACE, 'imp1', { accountId: 'imported', date: '2026-11-10', amountCents: -400, currency: 'EUR', merchant: 'KIOSK', needsReview: 1, importRef: 'ref-1' });
    await repo.upsert('transaction', SPACE, 'e-imp', { accountId: 'imported', date: '2026-11-10', amountCents: -400, currency: 'EUR', merchant: 'Kiosk', needsReview: 0, enteredAt: '2026-11-10T08:00:00.000Z', inBalance: 1 } as never);
    await feedRow('b1', '2026-11-10', -1250, 'SHOP');
    const accounts = new Map((await visibleAccounts(store, SPACE)).map((a) => [a.id, a]));
    expect([...(await bankRowsOf(store, SPACE, accounts)).keys()].sort()).toEqual(['b1', 'imp1']);
    // an imported row holds its opinions itself: the story lands on the row
    expect(await linkEntries(store, repo)).toBe(1);
    expect(await rowOf('e-imp')).toMatchObject({ bankTxId: 'imp1' });
    expect((await viewed()).map((tx) => tx.id)).toEqual(['b1', 'imp1']);
  });
});
