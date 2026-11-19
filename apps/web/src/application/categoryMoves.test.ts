// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { CATEGORY_BY_ID, childrenOf, mainCatOf } from '@/domain/categories';
import { GROCERY_SUB_BY_NAME, MERGED_BUILTINS, movedIds, movedStory } from '@/domain/categoryMoves';
import { applyCategoryMoves, foldOwnGroceries } from './categoryMoves';

const SPACE = 'sp1';
const OTHER_SPACE = 'sp2';

describe('#653: the catalog after Groceries got a main of its own', () => {
  it('ids that only moved or were renamed still resolve: grocery payments are Groceries › Other, tobacco is Groceries', () => {
    expect(mainCatOf('groceries')).toBe('grocery');
    expect(CATEGORY_BY_ID.get('groceries')?.isOther).toBe(true);
    expect(mainCatOf('tobacco')).toBe('grocery');
    for (const id of ['coffee', 'alcohol', 'sweets', 'takeout', 'lunchWork', 'breakfast', 'restaurants', 'consumptionOther']) {
      expect(mainCatOf(id)).toBe('consumption');
    }
    expect(CATEGORY_BY_ID.has('softDrinks')).toBe(false);
    expect(CATEGORY_BY_ID.has(MERGED_BUILTINS.get('softDrinks')!)).toBe(true);
  });

  it('no two subs under one main wear the same icon, and Groceries shares none with Eating out', () => {
    const icons = (main: string) => childrenOf(main).map((sub) => sub.icon);
    expect(new Set(icons('grocery')).size).toBe(icons('grocery').length);
    expect(icons('grocery').filter((icon) => icons('consumption').includes(icon))).toEqual([]);
  });

  it('a person’s own subs are told by any of the catalog’s names, and by the names the tree was built with', () => {
    expect(GROCERY_SUB_BY_NAME.get('dairy & eggs')).toBe('groceryDairy');
    expect(GROCERY_SUB_BY_NAME.get('zuivel & eieren')).toBe('groceryDairy');
    expect(GROCERY_SUB_BY_NAME.get('cooking basics')).toBe('groceryCooking');
    expect(GROCERY_SUB_BY_NAME.get('snacks & sweets')).toBe('grocerySnacks');
    expect(GROCERY_SUB_BY_NAME.get('tobacco')).toBe('tobacco');
    // every main has an Other: a name tells nothing, the row's own mark does
    expect(GROCERY_SUB_BY_NAME.has('other')).toBe(false);
  });

  it('a moved category is replaced wherever a story names it — row, spread, parts and their spreads — amounts untouched', () => {
    const story = {
      catId: 'softDrinks',
      cats: [{ catId: 'softDrinks', amountCents: 300 }, { catId: 'restaurants', amountCents: 700 }],
      splits: [
        { catId: 'softDrinks', amountCents: 400 },
        { catId: 'groceries', amountCents: 600, cats: [{ catId: 'softDrinks', amountCents: 100 }, { catId: 'groceries', amountCents: 500 }] },
      ],
    };
    expect(movedStory(story, MERGED_BUILTINS)).toEqual({
      catId: 'coffee',
      cats: [{ catId: 'coffee', amountCents: 300 }, { catId: 'restaurants', amountCents: 700 }],
      splits: [
        { catId: 'coffee', amountCents: 400 },
        { catId: 'groceries', amountCents: 600, cats: [{ catId: 'coffee', amountCents: 100 }, { catId: 'groceries', amountCents: 500 }] },
      ],
    });
    expect(movedStory({ catId: 'restaurants' }, MERGED_BUILTINS)).toBeNull();
    expect(movedIds(['softDrinks', 'coffee', 'sweets'], MERGED_BUILTINS)).toEqual(['coffee', 'sweets']);
    expect(movedIds(['sweets'], MERGED_BUILTINS)).toBeNull();
  });
});

describe('#653: what a device still holds follows the catalog', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function seed() {
    const store = new DexieBackend(new MunniDB(`munni_catmoves_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('catmoves'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, {
      name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', hiddenMains: ['own-main'],
      trendGraphs: [{ id: 'g1', name: 'Food', catIds: ['own-main', 'softDrinks', 'coffee'] }, { id: 'g2', name: 'Fun', catIds: ['entertainment'] }],
    });
    await repo.upsert('space', OTHER_SPACE, OTHER_SPACE, { name: 'Q', kind: 'personal', currency: 'EUR', periodType: 'month' });
    const cat = { color: '', txType: 'expense' as const, sortOrder: 1, builtin: 0 as const };
    await repo.upsert('category', SPACE, 'own-main', { ...cat, name: 'Groceries', icon: 'cart', color: '#E91E63', isParent: 1 });
    await repo.upsert('category', SPACE, 'own-dairy', { ...cat, name: 'Dairy & Eggs', icon: 'egg', parentId: 'own-main', direction: 'debit' });
    await repo.upsert('category', SPACE, 'own-basics', { ...cat, name: 'Cooking Basics', icon: 'pot', parentId: 'own-main', direction: 'debit' });
    await repo.upsert('category', SPACE, 'own-baby', { ...cat, name: 'Baby food', icon: 'baby', parentId: 'own-main', direction: 'debit' });
    await repo.upsert('category', SPACE, 'own-other', { ...cat, name: 'Other', icon: 'cart', parentId: 'own-main', direction: 'both', isOther: 1 });
    // a main of another name is nobody's business
    await repo.upsert('category', SPACE, 'hobby-main', { ...cat, name: 'Garden', icon: 'flower', isParent: 1 });
    const row = { accountId: 'a', currency: 'EUR', needsReview: 0 as const, merchant: 'Shop', date: '2026-11-01' };
    await repo.upsert('transaction', SPACE, 't-dairy', { ...row, amountCents: -500, catId: 'own-dairy' });
    await repo.upsert('transaction', SPACE, 't-baby', { ...row, amountCents: -700, catId: 'own-baby' });
    await repo.upsert('transaction', SPACE, 't-spread', {
      ...row, amountCents: -1000, catId: 'own-basics',
      cats: [{ catId: 'own-basics', amountCents: 600 }, { catId: 'own-other', amountCents: 400 }],
    });
    await repo.upsert('transaction', SPACE, 't-soft', { ...row, amountCents: -250, catId: 'softDrinks' });
    await repo.upsert('transaction', SPACE, 't-plain', { ...row, amountCents: -900, catId: 'groceries' });
    await repo.upsert('txMeta', SPACE, 'm1', { txId: 'feed-tx', catId: 'own-dairy', needsReview: 0 });
    await repo.upsert('recurring', SPACE, 'r1', { name: 'Box', kind: 'subscription', amountCents: 5000, every: 'week', dueDay: 1, active: 1, catId: 'own-main' });
    await repo.upsert('budget', SPACE, 'b1', { name: 'Food', amountCents: 40000, every: 'month', anchor: '2026-01-01', catIds: ['consumption', 'own-main', 'softDrinks'] });
    await repo.upsert('planSubject', SPACE, 'ps1', { planId: 'p', segment: 'expenses', order: 1, name: 'Food', catIds: ['own-main'], excludeCatIds: ['own-baby', 'own-dairy'] });
    await repo.upsert('receiptLink', SPACE, 'l1', {
      source: 'photo', date: '2026-11-01', totalCents: 500, auto: 0,
      items: [{ name: 'Melk', totalCents: 500, catId: 'own-dairy' }],
      picks: { 't-dairy': [{ line: 0, catId: 'own-dairy', amountCents: 500 }] },
    });
    return { store, repo };
  }

  it('a person’s own Groceries tree becomes the catalog’s: what was filed under it follows, a sub the catalog does not name stays theirs', async () => {
    const { store, repo } = await seed();
    expect(await applyCategoryMoves(store, repo)).toBeGreaterThan(0);

    expect((await store.get('transaction', 't-dairy'))?.catId).toBe('groceryDairy');
    expect((await store.get('transaction', 't-baby'))?.catId).toBe('own-baby');
    const spread = await store.get('transaction', 't-spread');
    expect(spread?.catId).toBe('groceryCooking');
    expect(spread?.cats).toEqual([{ catId: 'groceryCooking', amountCents: 600 }, { catId: 'groceries', amountCents: 400 }]);
    expect(spread?.amountCents).toBe(-1000);
    expect((await store.get('transaction', 't-soft'))?.catId).toBe('coffee');
    expect((await store.get('transaction', 't-plain'))?.catId).toBe('groceries');
    expect((await store.get('txMeta', 'm1'))?.catId).toBe('groceryDairy');
    expect((await store.get('recurring', 'r1'))?.catId).toBe('grocery');
    expect((await store.get('budget', 'b1'))?.catIds).toEqual(['consumption', 'grocery', 'coffee']);
    const subject = await store.get('planSubject', 'ps1');
    expect(subject?.catIds).toEqual(['grocery']);
    expect(subject?.excludeCatIds).toEqual(['own-baby', 'groceryDairy']);
    const link = await store.get('receiptLink', 'l1');
    expect(link?.items?.[0].catId).toBe('groceryDairy');
    expect(link?.picks?.['t-dairy'][0]).toMatchObject({ catId: 'groceryDairy', amountCents: 500 });
    const space = await store.get('space', SPACE);
    expect(space?.hiddenMains).toEqual(['grocery']);
    expect(space?.trendGraphs).toEqual([{ id: 'g1', name: 'Food', catIds: ['grocery', 'coffee'] }, { id: 'g2', name: 'Fun', catIds: ['entertainment'] }]);

    // the tree itself: the main and the named subs are gone, the unnamed one sits under the catalog's main
    for (const id of ['own-main', 'own-dairy', 'own-basics', 'own-other']) expect((await store.get('category', id))?.deleted).toBe(1);
    expect(await store.get('category', 'own-baby')).toMatchObject({ deleted: 0, parentId: 'grocery', name: 'Baby food' });
    expect((await store.get('category', 'hobby-main'))?.deleted).toBe(0);

    // nothing left to move: a second start writes nothing
    expect(await applyCategoryMoves(store, repo)).toBe(0);
  });

  it('a pass cut short goes on: the rows already moved stay, the main found again is finished', async () => {
    const { store, repo } = await seed();
    // as if the first pass had moved one row and stopped
    await repo.upsert('transaction', SPACE, 't-dairy', { catId: 'groceryDairy' });
    expect(await foldOwnGroceries(store, repo)).toBeGreaterThan(0);
    expect((await store.get('transaction', 't-dairy'))?.catId).toBe('groceryDairy');
    expect((await store.get('transaction', 't-spread'))?.catId).toBe('groceryCooking');
    expect((await store.get('category', 'own-main'))?.deleted).toBe(1);
  });

  it('a space this identity only reads is left to the people who write it', async () => {
    const { store } = await seed();
    const reader = new Repo(store, new HlcClock('reader'), { trackOutbox: false, readOnly: () => true, skipReadOnly: true });
    expect(await applyCategoryMoves(store, reader)).toBe(0);
    expect((await store.get('transaction', 't-soft'))?.catId).toBe('softDrinks');
    expect((await store.get('category', 'own-main'))?.deleted).toBe(0);
  });
});
