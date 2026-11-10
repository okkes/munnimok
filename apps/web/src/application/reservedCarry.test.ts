// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { writeTxTransform } from '@/db/joined';
import { accountLinkId, mirrorTxId, partMirrorSourceId, txMetaId } from '@/domain/feedIds';
import { carryReservedOpinions, carryReservedOpinionsWhenDue } from './reservedCarry';

const SPACE = 'space_carry';
const FEED = 'feed_carry';
const ACCOUNT = 'acct_carry';
let counter = 0;
let db: MunniDB;
let store: DexieBackend;
let repo: Repo;

/** a feed row as the ingest writes it — no opinion on it */
const feedRow = (id: string, date: string, amountCents: number, merchant: string, pending = false) =>
  repo.upsert('transaction', FEED, id, {
    accountId: ACCOUNT, date, amountCents, currency: 'EUR', merchant, needsReview: 1, ...(pending ? { pending: 1 as const } : {}),
  });

/** what the person said about a row in the space */
const opinion = (txId: string, fields: Record<string, unknown>) =>
  repo.upsert('txMeta', SPACE, txMetaId(SPACE, txId), { txId, needsReview: 1, ...fields } as never);

const metaOf = async (txId: string) => store.get('txMeta', txMetaId(SPACE, txId));

describe('a reserved charge hands its story to the booked row (#533)', () => {
  beforeEach(async () => {
    db = new MunniDB(`munni_reserved_carry_${++counter}`);
    store = new DexieBackend(db);
    repo = new Repo(store, new HlcClock('carry'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 } as never);
    await repo.upsert('account', FEED, ACCOUNT, { name: 'Bank · 9507', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('accountLink', SPACE, accountLinkId(SPACE, FEED), { feedSpaceId: FEED, accountId: ACCOUNT });
    await repo.upsert('event', SPACE, 'ev', { name: 'Study trip' });
  });
  afterEach(() => db.close());

  it('the booked twin takes the category, note and event — and still waits in the review', async () => {
    await feedRow('hold', '2026-10-13', -15_000, 'Total Nn0001853 Den Haa', true);
    await opinion('hold', { catId: 'transportFuel', notes: 'Rental car', eventId: 'ev' });
    // the bank booked it for what was tanked, and the settle took the hold out
    await feedRow('booked', '2026-10-14', -9083, 'Total Nn0001853 Den Haa');
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(1);
    const carried = await metaOf('booked');
    expect(carried).toMatchObject({ catId: 'transportFuel', notes: 'Rental car', eventId: 'ev', needsReview: 1 });
    // the hold's story is retired: a second pass (or device) carries nothing again
    expect((await metaOf('hold'))?.deleted).toBe(1);
    expect(await carryReservedOpinions(store, repo)).toBe(0);
  });

  it('what pointed at the hold points at the booked row — the other leg and a receipt', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'PAY.nl*X TU DELFT', true);
    await opinion('hold', { catId: 'restaurants', transferPeerId: 'leg' });
    // the other leg of a pair, on the space's own account
    await repo.upsert('account', SPACE, 'wallet', { name: 'Wallet', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('transaction', SPACE, 'leg', {
      accountId: 'wallet', date: '2026-10-06', amountCents: -1300, currency: 'EUR', merchant: 'TU Delft', needsReview: 0, transferPeerId: 'hold',
    });
    await repo.upsert('receiptLink', SPACE, 'rl', { receiptId: 'r1', txId: 'hold', source: 'photo', date: '2026-10-06', totalCents: 1300 });
    await feedRow('booked', '2026-10-07', -1300, 'PAY.nl*X TU DELFT');
    await repo.remove('transaction', FEED, 'hold');

    await carryReservedOpinions(store, repo);
    expect(await metaOf('booked')).toMatchObject({ catId: 'restaurants', transferPeerId: 'leg' });
    expect((await store.get('transaction', 'leg'))?.transferPeerId).toBe('booked');
    expect((await store.get('receiptLink', 'rl'))?.txId).toBe('booked');
  });

  it('a receipt alone is a story: the photo taken on the reserved payment shows on its booking', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'Albert Heijn 1842', true);
    await repo.upsert('receiptLink', SPACE, 'photo', { txId: 'hold', source: 'photo', date: '2026-10-06', totalCents: 1300 });
    await feedRow('booked', '2026-10-07', -1300, 'Albert Heijn 1842');
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(1);
    expect((await store.get('receiptLink', 'photo'))?.txId).toBe('booked');
  });

  it('a receipt the matcher asked about on the reserved payment asks on its booking', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'Albert Heijn 1842', true);
    await repo.upsert('receiptLink', SPACE, 'asked', { receiptId: 'rcpt:ah:c:1', proposedTxId: 'hold', source: 'ah', date: '2026-10-06', totalCents: 1300, auto: 0 });
    await feedRow('booked', '2026-10-07', -1300, 'Albert Heijn 1842');
    await repo.remove('transaction', FEED, 'hold');

    await carryReservedOpinions(store, repo);
    expect((await store.get('receiptLink', 'asked'))?.proposedTxId).toBe('booked');
  });

  it('a receipt asked about on a reservation that never books is free to be asked about again', async () => {
    await feedRow('hold', '2026-10-06', -2500, 'Hotel', true);
    await repo.upsert('receiptLink', SPACE, 'asked', { receiptId: 'rcpt:ah:c:2', proposedTxId: 'hold', source: 'ah', date: '2026-10-06', totalCents: 2500, auto: 0 });
    await repo.remove('transaction', FEED, 'hold');

    await carryReservedOpinions(store, repo);
    expect((await store.get('receiptLink', 'asked'))?.proposedTxId).toBe('hold');
    await carryReservedOpinions(store, repo, Date.now() + 15 * 86_400_000);
    expect((await store.get('receiptLink', 'asked'))?.proposedTxId ?? null).toBeNull();
  });

  it('a photo on a reservation whose booking was already filed moves to that booking, which keeps its filing', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'Albert Heijn 1842', true);
    await repo.upsert('receiptLink', SPACE, 'photo', { txId: 'hold', source: 'photo', date: '2026-10-06', totalCents: 1300 });
    await feedRow('booked', '2026-10-07', -1300, 'Albert Heijn 1842');
    await opinion('booked', { catId: 'restaurants', needsReview: 0 });
    await repo.remove('transaction', FEED, 'hold');

    await carryReservedOpinions(store, repo);
    expect((await store.get('receiptLink', 'photo'))?.txId).toBe('booked');
    expect(await metaOf('booked')).toMatchObject({ catId: 'restaurants', needsReview: 0 });
  });

  /** a reserved €50 split into groceries and €20 cash back, the cash part naming the manual wallet */
  const splitWithCashBack = async () => {
    await repo.upsert('account', SPACE, 'wallet', { name: 'Cash wallet', type: 'cash', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await feedRow('hold', '2026-10-06', -5000, 'Albert Heijn 1842', true);
    await writeTxTransform(repo, { id: 'hold', spaceId: SPACE, feedSpaceId: FEED, needsReview: 1 }, {
      splits: [
        { id: 'p1', catId: 'groceries', amountCents: 3000 },
        { id: 'p2', catId: 'cashWithdraw', amountCents: 2000, linkedAccountId: 'wallet' },
      ],
    });
    expect((await store.get('account', 'wallet'))?.balanceCents).toBe(2000);
  };
  const partLeg = (txId: string) => mirrorTxId(partMirrorSourceId(txId, 'p2'));

  it('a split part that names a manual account keeps its counter leg: the booked row gets its own, the balance stays', async () => {
    await splitWithCashBack();
    await feedRow('booked', '2026-10-07', -5000, 'Albert Heijn 1842');
    await repo.remove('transaction', FEED, 'hold');

    await carryReservedOpinions(store, repo);
    expect((await metaOf('booked'))?.splits?.find((part) => part.id === 'p2')).toMatchObject({ linkedAccountId: 'wallet', transferPeerId: partLeg('booked') });
    expect(await store.get('transaction', partLeg('booked'))).toMatchObject({ accountId: 'wallet', amountCents: 2000, deleted: 0 });
    expect((await store.get('transaction', partLeg('hold')))?.deleted).toBe(1);
    expect((await store.get('account', 'wallet'))?.balanceCents).toBe(2000);
  });

  it('and that leg follows the part when the bank books another amount', async () => {
    await splitWithCashBack();
    await feedRow('booked', '2026-10-07', -4500, 'Albert Heijn 1842');
    await repo.remove('transaction', FEED, 'hold');

    await carryReservedOpinions(store, repo);
    expect(await store.get('transaction', partLeg('booked'))).toMatchObject({ accountId: 'wallet', amountCents: 1800, deleted: 0 });
    expect((await store.get('account', 'wallet'))?.balanceCents).toBe(1800);
  });

  it('a booked row the review already filed keeps the person’s own decision', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'Albert Heijn', true);
    await opinion('hold', { catId: 'groceries' });
    await feedRow('booked', '2026-10-07', -1300, 'Albert Heijn');
    await opinion('booked', { catId: 'restaurants', needsReview: 0 });
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(0);
    expect(await metaOf('booked')).toMatchObject({ catId: 'restaurants', needsReview: 0 });
  });

  it('a booking the person already filed takes its reservation out of play — nothing lands on a look-alike', async () => {
    await feedRow('hold', '2026-10-06', -1000, 'Bakkerij Jansen', true);
    await opinion('hold', { catId: 'groceries', notes: 'Birthday cake', eventId: 'ev', needsReview: 0 });
    // its own booking, filed by hand since
    await feedRow('twin', '2026-10-07', -1000, 'Bakkerij Jansen');
    await opinion('twin', { catId: 'restaurants', needsReview: 0 });
    // still in the review: a later visit to the same shop, and a stranger of the same amount
    await feedRow('later', '2026-10-09', -1250, 'Bakkerij Jansen');
    await feedRow('parking', '2026-10-15', -1000, 'Q-Park Centrum');
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(0);
    expect(await metaOf('later')).toBeUndefined();
    expect(await metaOf('parking')).toBeUndefined();
    const filed = await metaOf('twin');
    expect(filed).toMatchObject({ catId: 'restaurants', needsReview: 0 });
    expect(filed?.notes).toBeUndefined();
    expect((await metaOf('hold'))?.deleted).toBe(1);
  });

  it('a reservation the bank released hands nothing to a stranger of the same amount', async () => {
    await feedRow('hold', '2026-10-06', -10_000, 'Hotel Les Sorbiers', true);
    await opinion('hold', { catId: 'hotel', notes: 'Deposit', needsReview: 0 });
    await repo.upsert('receiptLink', SPACE, 'photo', { txId: 'hold', source: 'photo', date: '2026-10-06', totalCents: 10_000 });
    await feedRow('other', '2026-10-12', -10_000, 'Coolblue BV');
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(0);
    expect(await metaOf('other')).toBeUndefined();
    expect((await store.get('receiptLink', 'photo'))?.txId).toBe('hold');
    // its own booking may still come
    expect((await metaOf('hold'))?.deleted).toBe(0);
  });

  it('two look-alike reservations each take their own booking, whether or not something was set on them', async () => {
    await feedRow('h1', '2026-10-06', -1300, 'TU Delft Catering', true);
    await feedRow('h2', '2026-10-07', -1300, 'TU Delft Catering', true);
    await opinion('h2', { notes: 'Lunch with Bas', needsReview: 0 });
    await feedRow('b1', '2026-10-07', -1300, 'TU Delft Catering');
    await feedRow('b2', '2026-10-08', -1300, 'TU Delft Catering');
    await repo.remove('transaction', FEED, 'h1');
    await repo.remove('transaction', FEED, 'h2');

    expect(await carryReservedOpinions(store, repo)).toBe(1);
    expect((await metaOf('b2'))?.notes).toBe('Lunch with Bas');
    expect(await metaOf('b1')).toBeUndefined();
  });

  it('a hold that never books lets its story go once no booking can follow — not before', async () => {
    await feedRow('hold', '2026-10-06', -2500, 'Hotel', true);
    await opinion('hold', { catId: 'hotel' });
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(0);
    expect((await metaOf('hold'))?.deleted).toBe(0);
    await carryReservedOpinions(store, repo, Date.now() + 15 * 86_400_000);
    expect((await metaOf('hold'))?.deleted).toBe(1);
  });

  it('a reservation gone longer than a booking may follow pairs with nothing, whatever looks like it', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'Albert Heijn', true);
    await opinion('hold', { catId: 'groceries' });
    await feedRow('lookalike', '2026-10-07', -1300, 'Albert Heijn');
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo, Date.now() + 15 * 86_400_000)).toBe(0);
    expect(await metaOf('lookalike')).toBeUndefined();
    expect((await metaOf('hold'))?.deleted).toBe(1);
  });

  it('the after-sync pass runs only when a pull moved on', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'TU Delft', true);
    await opinion('hold', { catId: 'restaurants' });
    await store.metaPut(`syncCursor_${FEED}`, 10);
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(0); // nothing booked yet
    await feedRow('booked', '2026-10-07', -1300, 'TU Delft');
    await repo.remove('transaction', FEED, 'hold');
    // the same pull position: the pass stands down
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(0);
    await store.metaPut(`syncCursor_${FEED}`, 12);
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(1);
  });

  it('the space’s own pull position starts no pass — every local write comes back through it', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'TU Delft', true);
    await opinion('hold', { catId: 'restaurants' });
    await store.metaPut(`syncCursor_${FEED}`, 10);
    await carryReservedOpinionsWhenDue(store, repo);
    await feedRow('booked', '2026-10-07', -1300, 'TU Delft');
    await repo.remove('transaction', FEED, 'hold');

    await store.metaPut(`syncCursor_${SPACE}`, 5);
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(0);
    await store.metaPut(`syncCursor_${FEED}`, 12);
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(1);
  });

  it('a story that lands after its reservation went still starts the pass', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'TU Delft', true);
    await feedRow('booked', '2026-10-07', -1300, 'TU Delft');
    await repo.remove('transaction', FEED, 'hold');
    await store.metaPut(`syncCursor_${FEED}`, 10);
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(0);

    // another device's note on the reservation arrives with the space's own pull
    await opinion('hold', { notes: 'Lunch with Bas' });
    await store.metaPut(`syncCursor_${SPACE}`, 5);
    expect(await carryReservedOpinionsWhenDue(store, repo)).toBe(1);
    expect((await metaOf('booked'))?.notes).toBe('Lunch with Bas');
  });
});
