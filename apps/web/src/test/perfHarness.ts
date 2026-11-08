import 'fake-indexeddb/auto';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import type { AccountLinkRow, AccountRow, ReceiptRow, RecurringRow, SpaceRow, StoreConnLinkRow, StoreConnRow, TransactionRow, TxMetaRow } from '@/db/types';
import { accountLinkId, storeConnLinkId, txMetaId } from '@/domain/feedIds';
import { HlcClock } from '@/sync/hlc';
import { applyOp } from '@/sync/merge';
import { perfBudget } from '@/lib/perf';

/**
 * A large, deterministic dataset for timing hot paths (user 2026-10-09:
 * "3–4 seconds on Confirm"): 1 500 transactions, 300 receipts and 40
 * recurring rows in a real Dexie store (fake-indexeddb), every row
 * carrying a proper sync envelope (built through the merge, written in
 * bulk so the seed itself stays cheap). The same seed yields the same
 * rows on every run, so timings compare across runs. PERF_BANK_SIZE adds
 * the shape a connected household has: a bank feed joined through an
 * accountLink with txMeta overlays, and a second space.
 *
 * From a *.test.ts (a budget assertion with CI headroom):
 *
 *   const data = await buildPerfStore();
 *   const { ms } = await timeIt('planning.build', () => buildPlanningModel(data.store, data.spaceId, ...));
 *   expect(ms).toBeLessThan(perfBudget['planning.build'] * 4);
 *   data.close();
 *
 * From a *.bench.ts (`npm run perf`), build the store in a `beforeAll`
 * and call the hot path inside `bench(...)`. Both stay out of the
 * coverage report (src/test/** is excluded).
 */

export const PERF_SPACE_ID = 'perf_space';
/** the receipts' owner feed, like the demo's store feed */
export const PERF_FEED_ID = 'perf_store_feed';
export const PERF_ACCOUNT_ID = 'perf_main';
export const PERF_CONNECTION_ID = 'perf_conn_ah';
/** a connected bank's feed and its one account (the tail the receipts' payment names) */
export const PERF_BANK_FEED_ID = 'perf_bank_feed';
export const PERF_BANK_ACCOUNT_ID = 'perf_bank';
export const perfOtherSpaceId = (n: number): string => `perf_space_${n}`;

export interface PerfDatasetSize {
  /** the space's own rows (manual entries, statement imports) */
  transactions: number;
  receipts: number;
  recurring: number;
  /** bank rows in an attached feed — the shape a connected bank lands in: joined
   *  through an accountLink, the reviewed ones dressed by the space's txMeta */
  feedTransactions: number;
  /** further real spaces attaching the same bank account and shop (a shared household) */
  otherSpaces: number;
}

export const PERF_DEFAULT_SIZE: Readonly<PerfDatasetSize> = Object.freeze({ transactions: 1500, receipts: 300, recurring: 40, feedTransactions: 0, otherSpaces: 0 });

/** a connected household (2026-11, #554): three years of a bank's rows, the shops' receipts, a second space */
export const PERF_BANK_SIZE: Readonly<PerfDatasetSize> = Object.freeze({ transactions: 300, receipts: 600, recurring: 40, feedTransactions: 4000, otherSpaces: 1 });

export interface PerfStore {
  db: MunniDB;
  store: DexieBackend;
  repo: Repo;
  spaceId: string;
  feedId: string;
  size: PerfDatasetSize;
  close(): void;
}

/** mulberry32 — a tiny seeded generator: the same rows every run */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MERCHANTS = ['Albert Heijn', 'Jumbo', 'Shell', 'NS', 'Bol.com', 'Amazon', 'Netflix', 'Spotify', 'Lidl', 'Etos', 'Hema', 'Action', 'Thuisbezorgd', 'Coolblue', 'Decathlon', 'Kruidvat'];
const CATEGORIES = ['groceries', 'transportFuel', 'transportPublic', 'subscriptions', 'shopping', 'eatingOut', 'health', 'housingRent'];
const ITEMS = ['Halfvolle melk', 'Bananen', 'Kipfilet', 'Volkoren brood', 'Griekse yoghurt', 'Koffiebonen', 'Wasmiddel', 'Tandpasta'];

const iso = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n: number): string => iso(new Date(Date.now() - n * 86_400_000));

const deleteDatabase = (name: string): Promise<void> =>
  new Promise((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });

/**
 * Opens a fresh store named `name` and fills it. Sizes default to the
 * dataset above; smaller sizes keep a smoke test quick.
 */
export async function buildPerfStore(size: Partial<PerfDatasetSize> = {}, name = 'munni_perf'): Promise<PerfStore> {
  await deleteDatabase(name);
  const db = new MunniDB(name);
  const store = new DexieBackend(db);
  // a frozen wall clock: the envelopes' HLC stamps are part of "the same rows every run"
  const clock = new HlcClock('perf', undefined, () => Date.UTC(2026, 9, 9, 12));
  const repo = new Repo(store, clock, { trackOutbox: false });
  const want: PerfDatasetSize = { ...PERF_DEFAULT_SIZE, ...size };
  const random = rng(42);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  // the merge stamps the envelope exactly as a Repo write would
  const row = <T extends Record<string, unknown>>(entity: string, spaceId: string, id: string, fields: T) => ({
    ...applyOp<T>(null, { opId: `${entity}:${id}`, spaceId, entity, entityId: id, fields, hlc: clock.now() }).row,
    id,
    spaceId,
  });

  await repo.upsert('space', PERF_SPACE_ID, PERF_SPACE_ID, { name: 'Perf', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', PERF_SPACE_ID, PERF_ACCOUNT_ID, { name: 'Main', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 250_000 });

  const recurrings: RecurringRow[] = Array.from({ length: want.recurring }, (_, i) => {
    const merchant = MERCHANTS[i % MERCHANTS.length];
    return row('recurring', PERF_SPACE_ID, `perf_rec_${i}`, {
      name: `${merchant} ${i}`,
      kind: i % 3 === 0 ? 'fixed' : 'subscription',
      amountCents: 500 + Math.floor(random() * 20_000),
      catId: pick(CATEGORIES),
      every: i % 7 === 0 ? 'year' : 'month',
      dueDay: 1 + (i % 28),
      active: 1,
      merchantKey: merchant.toLowerCase(),
    }) as RecurringRow;
  });

  // eighteen months of history; the newest sixty await review (a deck)
  const transactions: TransactionRow[] = Array.from({ length: want.transactions }, (_, i) => {
    const merchant = pick(MERCHANTS);
    const income = i % 25 === 0;
    const recurring = !income && i % 20 === 0 ? recurrings[i % Math.max(1, recurrings.length)] : undefined;
    const amountCents = income ? 250_000 + Math.floor(random() * 50_000) : -(100 + Math.floor(random() * 15_000));
    const uncategorised = i % 15 === 0;
    return row('transaction', PERF_SPACE_ID, `perf_tx_${i}`, {
      accountId: PERF_ACCOUNT_ID,
      date: daysAgo(Math.floor((i / want.transactions) * 540)),
      time: `${String(8 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`,
      amountCents,
      currency: 'EUR',
      merchant: income ? 'Employer BV' : merchant,
      description: income ? `Salaris ${i}` : `${merchant} betaling ${i}`,
      ...(uncategorised ? {} : { catId: income ? 'income' : (recurring?.catId ?? pick(CATEGORIES)) }),
      ...(recurring ? { recurringId: recurring.id } : {}),
      needsReview: i < 60 || uncategorised ? 1 : 0,
      importRef: `perf-ref-${i}`,
    }) as TransactionRow;
  });

  // a bank's three years, newest first: the newest sixty await review (no
  // overlay yet — the join reads them as unreviewed), the rest were filed
  // in every space that attaches the account; every third charge is a till
  // line of the shop whose receipts the store feed holds
  const otherSpaceIds = Array.from({ length: want.otherSpaces }, (_, n) => perfOtherSpaceId(n + 1));
  const viewers = want.feedTransactions > 0 ? [PERF_SPACE_ID, ...otherSpaceIds] : [];
  // the seeded pick only where neither the salary nor the till line names it (the same rows every run)
  const feedMerchant = (i: number, income: boolean): string => {
    if (income) return 'Employer BV';
    return i % 3 === 1 ? 'Albert Heijn 1470 AMS' : pick(MERCHANTS);
  };
  const feedTxs: TransactionRow[] = Array.from({ length: want.feedTransactions }, (_, i) => {
    const income = i % 30 === 0;
    const merchant = feedMerchant(i, income);
    return row('transaction', PERF_BANK_FEED_ID, `perf_btx_${i}`, {
      accountId: PERF_BANK_ACCOUNT_ID,
      date: daysAgo(Math.floor((i / want.feedTransactions) * 1095)),
      amountCents: income ? 250_000 + Math.floor(random() * 50_000) : -(100 + Math.floor(random() * 15_000)),
      currency: 'EUR',
      merchant,
      description: `${merchant} ${i}`,
      importRef: `perf-bank-${i}`,
    }) as TransactionRow;
  });
  const metas: TxMetaRow[] = viewers.flatMap((viewer) =>
    feedTxs.slice(60).map((tx, i) =>
      row('txMeta', viewer, txMetaId(viewer, tx.id), {
        txId: tx.id,
        catId: tx.amountCents > 0 ? 'income' : CATEGORIES[i % CATEGORIES.length],
        needsReview: 0,
      }) as TxMetaRow,
    ),
  );
  const ahFeed = feedTxs.filter((tx) => tx.amountCents < 0 && tx.merchant?.startsWith('Albert Heijn'));
  const twinOf = (i: number): TransactionRow | undefined => {
    if (i % 2 !== 0) return undefined;
    // with a bank attached, every other twin is one of its till lines
    if (ahFeed.length > 0 && i % 4 === 0) return ahFeed[(i / 4) % ahFeed.length];
    return transactions[(i * 5) % transactions.length];
  };

  // half the receipts mirror a transaction (same day, same total: the
  // matcher has work), the other half have no counterpart
  const receipts: ReceiptRow[] = Array.from({ length: want.receipts }, (_, i) => {
    const twin = twinOf(i);
    const totalCents = twin ? Math.abs(twin.amountCents) : 200 + Math.floor(random() * 9_000);
    const lines = 1 + (i % 4);
    const items = Array.from({ length: lines }, (_, j) => ({ name: ITEMS[(i + j) % ITEMS.length], qty: 1, totalCents: j === lines - 1 ? totalCents - Math.floor(totalCents / lines) * (lines - 1) : Math.floor(totalCents / lines) }));
    return row('receipt', PERF_FEED_ID, `rcpt:ah:${PERF_CONNECTION_ID}:r${i}`, {
      source: 'ah',
      date: twin?.date ?? daysAgo(Math.floor(random() * 540)),
      totalCents,
      currency: 'EUR',
      merchant: twin?.merchant ?? 'Albert Heijn',
      storeRef: `ah:r${i}`,
      instanceId: PERF_CONNECTION_ID,
      items,
      payment: { method: 'PINNEN', accountTail: '1234' },
    }) as ReceiptRow;
  });

  // the shop's connection and its inclusion in every space: what the matcher walks
  const spaces = otherSpaceIds.map(
    (id, n) => row('space', id, id, { name: `Perf ${n + 2}`, kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 }) as SpaceRow,
  );
  const storeConn = row('storeConn', PERF_FEED_ID, PERF_CONNECTION_ID, { store: 'ah', kind: 'store', displayName: 'Albert Heijn', connectedAt: '2024-01-01T00:00:00Z' }) as StoreConnRow;
  const connLinks = [PERF_SPACE_ID, ...otherSpaceIds].map(
    (spaceId) => row('storeConnLink', spaceId, storeConnLinkId(spaceId, PERF_CONNECTION_ID), { instanceId: PERF_CONNECTION_ID, store: 'ah', displayName: 'Albert Heijn' }) as StoreConnLinkRow,
  );
  const accountLinks = viewers.map(
    (viewer) => row('accountLink', viewer, accountLinkId(viewer, PERF_BANK_FEED_ID), { feedSpaceId: PERF_BANK_FEED_ID, accountId: PERF_BANK_ACCOUNT_ID, type: 'checking' }) as AccountLinkRow,
  );

  await db.transaction('rw', [db.spaces, db.accounts, db.accountLinks, db.transactions, db.txMeta, db.receipts, db.recurrings, db.storeConns, db.storeConnLinks], async () => {
    await db.spaces.bulkPut(spaces);
    if (feedTxs.length > 0) {
      await db.accounts.put(
        row('account', PERF_BANK_FEED_ID, PERF_BANK_ACCOUNT_ID, { name: 'ING', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 180_000, iban: 'NL91INGB0001231234' }) as AccountRow,
      );
    }
    await db.accountLinks.bulkPut(accountLinks);
    await db.recurrings.bulkPut(recurrings);
    await db.transactions.bulkPut([...transactions, ...feedTxs]);
    await db.txMeta.bulkPut(metas);
    await db.receipts.bulkPut(receipts);
    await db.storeConns.put(storeConn);
    await db.storeConnLinks.bulkPut(connLinks);
  });

  return { db, store, repo, spaceId: PERF_SPACE_ID, feedId: PERF_FEED_ID, size: want, close: () => db.close() };
}

export interface Timing<T> {
  ms: number;
  result: T;
}

/**
 * Run `fn` once and say how long it took (`[perf] label: 123 ms`), with
 * the budget beside it when `label` has one (lib/perf perfBudget) or one
 * is given. The caller asserts; CI boxes are slower than a laptop, so
 * leave headroom (3–4× the budget).
 */
export async function timeIt<T>(label: string, fn: () => T | Promise<T>, budget: number | undefined = perfBudget[label]): Promise<Timing<T>> {
  const started = performance.now();
  const result = await fn();
  const ms = performance.now() - started;
  const over = budget !== undefined && ms > budget ? ' — OVER' : '';
  const verdict = budget === undefined ? '' : ` (budget ${budget} ms${over})`;
  console.info(`[perf] ${label}: ${Math.round(ms)} ms${verdict}`);
  return { ms, result };
}
