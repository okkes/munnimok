// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { applyCatalogTombstones, normalizeReimbursements } from './catalogMaintenance';

const SPACE = 's1';

describe('catalog tombstone pass (AC3)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function seeded() {
    const store = new DexieBackend(new MunniDB(`munni_ac3_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('ac3'), { trackOutbox: false });
    // a custom sub the user created under the soon-retired builtin 'gift'
    await repo.upsert('category', SPACE, 'sub1', {
      parentId: 'gift', name: 'Wrapping', icon: 'gift', color: '', txType: 'expense', sortOrder: 1, builtin: 0,
    });
    // transactions on the retired builtin, on the custom sub, and elsewhere
    await repo.upsert('transaction', SPACE, 't-gift', { accountId: 'a', date: '2026-01-01', amountCents: -100, currency: 'EUR', merchant: 'X', catId: 'gift', txType: 'expense', needsReview: 0 });
    await repo.upsert('transaction', SPACE, 't-sub', { accountId: 'a', date: '2026-01-02', amountCents: -200, currency: 'EUR', merchant: 'Y', catId: 'sub1', txType: 'expense', needsReview: 0 });
    await repo.upsert('transaction', SPACE, 't-keep', { accountId: 'a', date: '2026-01-03', amountCents: -300, currency: 'EUR', merchant: 'Z', catId: 'groceries', txType: 'expense', needsReview: 0 });
    // a feed overlay pointing at the retired id
    await repo.upsert('txMeta', SPACE, 'm1', { txId: 'raw1', catId: 'gift', txType: 'expense', needsReview: 0 });
    await store.metaPut('catalog', {
      version: 4,
      categories: [{ id: 'gift', deleted: true, names: { en: 'Gift', nl: 'Cadeau', tr: 'Hediye' }, icon: 'gift-outline' }],
      keywords: [],
    });
    return { store, repo };
  }

  it('detaches retired builtins, cascades custom subs, leaves the rest', async () => {
    const { store, repo } = await seeded();
    const touched = await applyCatalogTombstones(store, repo);
    expect(touched).toBe(4); // sub cascade + 2 transactions + 1 overlay

    expect((await store.get('category', 'sub1'))?.deleted).toBe(1); // cascaded
    expect(await store.get('transaction', 't-gift')).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
    expect(await store.get('transaction', 't-sub')).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
    expect(await store.get('transaction', 't-keep')).toMatchObject({ catId: 'groceries', needsReview: 0 });
    expect(await store.get('txMeta', 'm1')).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
  });

  it('runs once per version (marker), and not at all without a document', async () => {
    const { store, repo } = await seeded();
    await applyCatalogTombstones(store, repo);
    expect(await applyCatalogTombstones(store, repo)).toBe(0); // marker gates the rerun

    const fresh = new DexieBackend(new MunniDB(`munni_ac3_${Math.random().toString(36).slice(2)}`));
    stores.push(fresh);
    const freshRepo = new Repo(fresh, new HlcClock('ac3b'), { trackOutbox: false });
    expect(await applyCatalogTombstones(fresh, freshRepo)).toBe(0); // no doc, no work
  });
});

describe('#228: the every-boot reimbursement normalizer', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('a link made before the credit was split NAMES its part, and both sides settle in their own cats', async () => {
    const store = new DexieBackend(new MunniDB(`munni_rbn_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('rbn'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month' });
    // a +2400 credit that gave 4.20 while whole, then got split in two
    await repo.upsert('transaction', SPACE, 'salary', {
      accountId: 'a', date: '2026-07-24', amountCents: 240_000, currency: 'EUR', merchant: 'Demo Corp BV',
      catId: 'salary', txType: 'income', needsReview: 0,
      splits: [
        { id: 'p1', catId: 'salary', amountCents: 120_000 },
        { id: 'p2', catId: 'incomeOther', amountCents: 120_000 },
      ],
    });
    // the koffie expense's link points at the whole credit — no part yet
    await repo.upsert('transaction', SPACE, 'koffie', {
      accountId: 'a', date: '2026-07-25', amountCents: -420, currency: 'EUR', merchant: 'Koffie',
      catId: 'eatingOut', txType: 'expense', needsReview: 0,
      reimbursements: [{ txId: 'salary', amountCents: 420 }],
    });
    // untouched: no links anywhere near it
    await repo.upsert('transaction', SPACE, 'plain', {
      accountId: 'a', date: '2026-01-03', amountCents: -500, currency: 'EUR', merchant: 'Z',
      catId: 'coffee', txType: 'expense', needsReview: 0,
    });

    expect(await normalizeReimbursements(store, repo)).toBeGreaterThan(0);

    // the link now names the largest open credit part deterministically
    const koffie = await store.get('transaction', 'koffie');
    expect(koffie?.reimbursements?.[0]?.creditPartId).toBe('p1');
    // …and the koffie expense settled in its own cats
    expect(koffie?.cats).toMatchObject([{ catId: 'reimbursed', amountCents: 420 }]);

    const salary = await store.get('transaction', 'salary');
    const parts = salary?.splits ?? [];
    expect(parts.map((p) => p.amountCents)).toEqual([120_000, 120_000]);
    // the named part carries the settle inside its OWN cats
    expect(parts[0].cats).toMatchObject([
      { catId: 'salary', amountCents: 119_580 },
      { catId: 'reimbursed', amountCents: 420 },
    ]);
    expect(parts[1].cats ?? undefined).toBeFalsy();
    expect((await store.get('transaction', 'plain'))?.cats).toBeUndefined();

    // every boot, no marker — a second run rewrites nothing
    expect(await normalizeReimbursements(store, repo)).toBe(0);
  });
});
