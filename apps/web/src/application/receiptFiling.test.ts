// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { visibleTransactions } from '@/db/joined';
import type { ReceiptItem } from '@/db/types';
import { fileByReceipt } from './receiptFiling';

const SPACE = 'space_filing';
let counter = 0;
let db: MunniDB;
let store: DexieBackend;
let repo: Repo;

const known = () => true;
const LINES: ReceiptItem[] = [
  { name: 'Halfvolle melk', totalCents: 1000 },
  { name: 'Chocolade', totalCents: 800, catId: 'sweets' },
  { name: 'Brood', totalCents: 760 },
  { name: 'Bonus', totalCents: -250, kind: 'discount' },
];

const payment = (id: string, amountCents: number, more: Record<string, unknown> = {}) =>
  repo.upsert('transaction', SPACE, id, {
    accountId: 'wallet', date: '2026-11-12', amountCents, currency: 'EUR', merchant: 'Albert Heijn', needsReview: 0, catId: 'groceries', txType: 'expense', ...more,
  } as never);
const receipt = (id: string, txId: string, totalCents: number, more: Record<string, unknown> = {}) =>
  repo.upsert('receiptLink', SPACE, id, { txId, source: 'photo', date: '2026-11-12', totalCents, merchant: 'Albert Heijn', items: LINES, auto: 0, ...more } as never);
const viewed = async (id: string) => (await visibleTransactions(store, SPACE)).find((tx) => tx.id === id)!;

/** #567: a receipt attached to a payment of the same amount files it by its lines */
describe('a payment filed by its receipt', () => {
  beforeEach(async () => {
    db = new MunniDB(`munni_receipt_filing_${++counter}`);
    store = new DexieBackend(db);
    repo = new Repo(store, new HlcClock('filing'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 } as never);
    await repo.upsert('account', SPACE, 'wallet', { name: 'Wallet', type: 'cash', source: 'manual', currency: 'EUR', balanceCents: 0 });
  });
  afterEach(() => db.close());

  it('the same amount: the line the reader named takes its paid share, the rest stays where the payment was — and the picks are kept with the receipt', async () => {
    await payment('t1', -2310);
    await receipt('r1', 't1', 2310);
    expect(await fileByReceipt(store, repo, SPACE, 't1', known)).toBe(true);

    const tx = await viewed('t1');
    expect(tx.cats?.map(({ catId, amountCents }) => ({ catId, amountCents }))).toEqual([
      { catId: 'sweets', amountCents: 722 },
      { catId: 'groceries', amountCents: 1588 },
    ]);
    expect(tx.catId).toBe('groceries');
    expect(tx.needsReview).toBe(0);
    expect((await store.get('receiptLink', 'r1'))?.picks).toEqual({ t1: [{ line: 1, catId: 'sweets', amountCents: 722 }] });
    // filed once: the payment tells a story of its own now
    expect(await fileByReceipt(store, repo, SPACE, 't1', known)).toBe(false);
  });

  it('what the person filed before outranks the reader, across receipts — and a payment still to review stays to review', async () => {
    await payment('old', -1000, { cats: undefined });
    await receipt('r0', 'old', 1000, {
      date: '2026-11-01',
      items: [{ name: 'chocolade', totalCents: 1000 }],
      picks: { old: [{ line: 0, catId: 'coffee', amountCents: 1000 }] },
    });
    await payment('t2', -2310, { needsReview: 1 });
    await receipt('r2', 't2', 2310);
    expect(await fileByReceipt(store, repo, SPACE, 't2', known)).toBe(true);
    const tx = await viewed('t2');
    expect(tx.cats?.find((entry) => entry.catId === 'coffee')?.amountCents).toBe(722);
    expect(tx.cats?.some((entry) => entry.catId === 'sweets')).toBe(false);
    expect(tx.needsReview).toBe(1);
  });

  it('every line under one category is a plain category, no spread', async () => {
    await payment('t3', -500, { catId: 'groceries' });
    await receipt('r3', 't3', 500, { items: [{ name: 'Reep', totalCents: 500, catId: 'sweets' }] });
    expect(await fileByReceipt(store, repo, SPACE, 't3', known)).toBe(true);
    const tx = await viewed('t3');
    expect(tx.catId).toBe('sweets');
    expect(tx.cats ?? []).toEqual([]);
  });

  it('a different amount, no receipt, or a category that is gone: nothing is filed', async () => {
    await payment('t4', -2500);
    await receipt('r4', 't4', 2310);
    expect(await fileByReceipt(store, repo, SPACE, 't4', known)).toBe(false);
    expect((await viewed('t4')).cats ?? []).toEqual([]);

    await payment('t5', -2310);
    expect(await fileByReceipt(store, repo, SPACE, 't5', known)).toBe(false);
    expect(await fileByReceipt(store, repo, SPACE, 'nobody', known)).toBe(false);

    await receipt('r5', 't5', 2310);
    expect(await fileByReceipt(store, repo, SPACE, 't5', () => false)).toBe(false);
    expect((await store.get('receiptLink', 'r5'))?.picks).toBeUndefined();
  });
});
