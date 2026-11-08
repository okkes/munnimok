// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { accountLinkId, txMetaId } from '@/domain/feedIds';
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

  it('a booked row the review already filed keeps the person’s own decision', async () => {
    await feedRow('hold', '2026-10-06', -1300, 'Albert Heijn', true);
    await opinion('hold', { catId: 'groceries' });
    await feedRow('booked', '2026-10-07', -1300, 'Albert Heijn');
    await opinion('booked', { catId: 'restaurants', needsReview: 0 });
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(0);
    expect(await metaOf('booked')).toMatchObject({ catId: 'restaurants', needsReview: 0 });
  });

  it('a hold that never books lets its story go after a month — not before', async () => {
    await feedRow('hold', '2026-10-06', -2500, 'Hotel', true);
    await opinion('hold', { catId: 'hotel' });
    await repo.remove('transaction', FEED, 'hold');

    expect(await carryReservedOpinions(store, repo)).toBe(0);
    expect((await metaOf('hold'))?.deleted).toBe(0);
    await carryReservedOpinions(store, repo, Date.now() + 31 * 86_400_000);
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
});
