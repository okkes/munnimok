// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import {
  copyCount,
  copyFaces,
  copyGroupToSpace,
  copyGroups,
  createMainCategory,
  createSubCategory,
  directionForType,
  iconConflict,
} from './categoryOps';

describe('#244: direction derives from the parent — the user never states it', () => {
  it('income subs are credit, expense subs debit, anything else open', () => {
    expect(directionForType('income')).toBe('credit');
    expect(directionForType('expense')).toBe('debit');
    expect(directionForType('saving')).toBe('both');
  });

  it('createSubCategory stamps the derived direction', async () => {
    const db = new MunniDB(`munni_test_dir_${Math.random().toString(36).slice(2)}`);
    const store = new DexieBackend(db);
    const repo = new Repo(store, new HlcClock('d'), { trackOutbox: false });
    const underIncome = await createSubCategory(store, repo, 'p1', { parentId: 'income', name: 'Royalties', icon: 'cash' });
    const underSport = await createSubCategory(store, repo, 'p1', { parentId: 'sport', name: 'Padel', icon: 'dumbbell' });
    expect(await store.get('category', underIncome)).toMatchObject({ txType: 'income', direction: 'credit' });
    expect(await store.get('category', underSport)).toMatchObject({ txType: 'expense', direction: 'debit' });
  });
});

describe('#389 iconConflict / #390 copyableUnits', () => {
  it('a sub may not take the icon of a sibling under the same main; itself and other mains do not count', () => {
    const rows = [
      { id: 'a', icon: 'coffee-outline', parentId: 'food' },
      { id: 'b', icon: 'pizza', parentId: 'food' },
      { id: 'c', icon: 'coffee-outline', parentId: 'sport' },
    ];
    expect(iconConflict({ icon: 'coffee-outline', parentId: 'food' }, rows)).toBe(true);
    expect(iconConflict({ icon: 'coffee-outline', parentId: 'food', selfId: 'a' }, rows)).toBe(false);
    expect(iconConflict({ icon: 'coffee-outline', parentId: 'sport', selfId: 'c' }, rows)).toBe(false);
    expect(iconConflict({ icon: 'coffee-outline' }, rows)).toBe(false);
  });

  const spaces = [
    { id: 'here', name: 'Home', kind: 'personal', deleted: 0 },
    { id: 'other', name: 'Family', kind: 'shared', deleted: 0 },
    { id: 'gone', name: 'Old', kind: 'personal', deleted: 1 },
  ] as never[];

  it('offers the other spaces\' custom categories this space lacks — per main, every sub its own pick, by name', () => {
    const rows = [
      { id: 'm1', spaceId: 'other', isParent: 1, name: 'Padel', icon: 'tennis', deleted: 0 },
      { id: 'm1-other', spaceId: 'other', isParent: 0, isOther: 1, parentId: 'm1', name: 'Other', icon: 'dots', deleted: 0 },
      { id: 's1', spaceId: 'other', isParent: 0, parentId: 'm1', name: 'Court', icon: 'map', deleted: 0 },
      { id: 's2', spaceId: 'other', isParent: 0, parentId: 'sport', name: 'Swim', icon: 'swim', deleted: 0 },
      { id: 's3', spaceId: 'other', isParent: 0, parentId: 'sport', name: 'Yoga', icon: 'yoga', deleted: 0 },
      { id: 'h1', spaceId: 'here', isParent: 0, parentId: 'sport', name: 'yoga', icon: 'meditation', deleted: 0 },
      // a main both spaces have: only the subs this one lacks are offered, joining the main here
      { id: 'm2', spaceId: 'other', isParent: 1, name: 'Groceries', icon: 'cart', deleted: 0 },
      { id: 's4', spaceId: 'other', isParent: 0, parentId: 'm2', name: 'Spices', icon: 'shaker', deleted: 0 },
      { id: 's5', spaceId: 'other', isParent: 0, parentId: 'm2', name: 'Bread', icon: 'baguette', deleted: 0 },
      { id: 'h2', spaceId: 'here', isParent: 1, name: 'groceries', icon: 'cart', deleted: 0 },
      { id: 'h3', spaceId: 'here', isParent: 0, parentId: 'h2', name: 'Bread', icon: 'bread-slice', deleted: 0 },
      // locked specials take no subs; spaces that are gone offer nothing
      { id: 's6', spaceId: 'other', isParent: 0, parentId: 'transfer', name: 'Pocket money', icon: 'cash', deleted: 0 },
      { id: 'x1', spaceId: 'gone', isParent: 1, name: 'Ghost', icon: 'ghost', deleted: 0 },
    ] as never[];
    const groups = copyGroups('here', spaces, rows);
    expect(groups.map((g) => g.main?.id ?? `into:${g.intoId}`)).toEqual(['m1', 'into:h2', 'into:sport']);
    expect(groups[0].subs.map((r) => r.id)).toEqual(['s1']); // the main brings its own subs, never its Other
    expect(groups[1].subs.map((r) => r.id)).toEqual(['s4']);
    expect(groups[2].subs.map((r) => r.id)).toEqual(['s2']);
    expect(groups[0].space.name).toBe('Family');
    // the banner counts a main once and each sub that joins a main here
    expect(copyCount(groups)).toBe(3);
  });

  it('#389: a copied sub keeps its icon unless a sibling there wears it — then the first free one', () => {
    const group = {
      space: spaces[1],
      intoId: 'sport',
      subs: [
        { id: 'a', icon: 'dumbbell' },
        { id: 'b', icon: 'tennis' },
        { id: 'c', icon: 'silverware-fork-knife' },
      ],
    } as never;
    const faces = copyFaces(group, new Set(['dumbbell', 'silverware-fork-knife']));
    expect(faces.get('a')).toBe('coffee-outline');
    expect(faces.get('b')).toBe('tennis');
    expect(faces.get('c')).toBe('cart-outline');
  });

  it('copies a picked main with its Other and only the picked subs; picked subs join a main here', async () => {
    const db = new MunniDB(`munni_test_copy_${Math.random().toString(36).slice(2)}`);
    const store = new DexieBackend(db);
    const repo = new Repo(store, new HlcClock('d'), { trackOutbox: false });
    const mainId = await createMainCategory(repo, 'other', { name: 'Padel', icon: 'tennis', color: '#123456', txType: 'expense', otherName: 'Other' });
    const court = await createSubCategory(store, repo, 'other', { parentId: mainId, name: 'Court', icon: 'map' });
    await createSubCategory(store, repo, 'other', { parentId: mainId, name: 'Rackets', icon: 'tennis-ball' });
    const swim = await createSubCategory(store, repo, 'other', { parentId: 'sport', name: 'Swim', icon: 'dumbbell' });
    const groups = copyGroups('here', spaces, await store.allRows('category'));
    const picked = new Set([mainId, court, swim]);
    for (const group of groups) await copyGroupToSpace(store, repo, 'here', group, picked, copyFaces(group, new Set(group.intoId === 'sport' ? ['dumbbell'] : [])));

    const here = (await store.allRows('category')).filter((r) => r.spaceId === 'here');
    const main = here.find((r) => r.isParent === 1)!;
    expect(main).toMatchObject({ name: 'Padel', icon: 'tennis', color: '#123456' });
    expect(here.filter((r) => r.parentId === main.id).map((r) => r.name).sort()).toEqual(['Court', 'Other']);
    expect(here.find((r) => r.name === 'Swim')).toMatchObject({ parentId: 'sport', icon: 'silverware-fork-knife' });
    db.close();
  });
});
