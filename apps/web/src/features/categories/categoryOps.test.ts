// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { copyableUnits, createSubCategory, directionForType, iconConflict } from './categoryOps';

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

  it('offers the other spaces\' custom categories this space lacks — mains with their subs, lone subs under catalog mains — by name', () => {
    const spaces = [
      { id: 'here', name: 'Home', kind: 'personal', deleted: 0 },
      { id: 'other', name: 'Family', kind: 'shared', deleted: 0 },
      { id: 'gone', name: 'Old', kind: 'personal', deleted: 1 },
    ] as never[];
    const rows = [
      { id: 'm1', spaceId: 'other', isParent: 1, name: 'Padel', icon: 'tennis', deleted: 0 },
      { id: 'm1-other', spaceId: 'other', isParent: 0, isOther: 1, parentId: 'm1', name: 'Other', icon: 'dots', deleted: 0 },
      { id: 's1', spaceId: 'other', isParent: 0, parentId: 'm1', name: 'Court', icon: 'map', deleted: 0 },
      { id: 's2', spaceId: 'other', isParent: 0, parentId: 'sport', name: 'Swim', icon: 'swim', deleted: 0 },
      { id: 's3', spaceId: 'other', isParent: 0, parentId: 'sport', name: 'Yoga', icon: 'yoga', deleted: 0 },
      { id: 'h1', spaceId: 'here', isParent: 0, parentId: 'sport', name: 'yoga', icon: 'meditation', deleted: 0 },
      { id: 'x1', spaceId: 'gone', isParent: 1, name: 'Ghost', icon: 'ghost', deleted: 0 },
    ] as never[];
    const units = copyableUnits('here', spaces, rows);
    expect(units.map((u) => u.row.id)).toEqual(['m1', 's2']);
    expect(units[0].subs.map((r) => r.id)).toEqual(['s1']); // the main brings its subs, not its Other
    expect(units[0].space.name).toBe('Family');
  });
});
