// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { HlcClock } from '@/sync/hlc';
import { DEMO_SPACE_ID } from '@/db/seed';
import { renderApp } from '@/test/harness';

describe('copying categories from several other spaces', { timeout: 15_000 }, () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('offers what two spaces both hold once, and what lands under one main never shares a name or an icon', async () => {
    renderApp('/categories');
    await screen.findByTestId('cats-group-consumption');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    const space = { kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 } as const;
    const custom = { color: '', txType: 'expense', direction: 'debit', sortOrder: 999, builtin: 0 } as const;
    // Family and Personal hold the same Hobby and the same Padel; Personal's Squash wears Padel's icon,
    // and Family's Paint wears the icon of Hobby's own Other
    for (const [spaceId, name] of [['s-fam', 'Family'], ['s-own', 'Personal']] as const) {
      await repo.upsert('space', spaceId, spaceId, { ...space, name });
      await repo.upsert('category', spaceId, `${spaceId}-hobby`, { ...custom, name: 'Hobby', icon: 'palette', color: '#E91E63', isParent: 1 });
      await repo.upsert('category', spaceId, `${spaceId}-other`, { ...custom, parentId: `${spaceId}-hobby`, name: 'Other', icon: 'palette', isOther: 1, sortOrder: 9999 });
      await repo.upsert('category', spaceId, `${spaceId}-paint`, { ...custom, parentId: `${spaceId}-hobby`, name: 'Paint', icon: 'palette' });
      await repo.upsert('category', spaceId, `${spaceId}-padel`, { ...custom, parentId: 'sport', name: 'Padel', icon: 'tennis-ball' });
    }
    await repo.upsert('category', 's-own', 's-own-squash', { ...custom, parentId: 'sport', name: 'Squash', icon: 'tennis-ball' });
    db.close();

    // Hobby, Padel and Squash — each once (the live query may land the writes one by one)
    await waitFor(() => expect(screen.getByTestId('cats-copy-open').textContent).toContain('3 custom categories'), { timeout: 5000 });
    fireEvent.click(screen.getByTestId('cats-copy-open'));
    fireEvent.click(await screen.findByTestId('cats-copy-unit-s-fam-hobby'));
    expect(screen.queryByTestId('cats-copy-unit-s-own-hobby')).toBeNull();
    expect(screen.queryByTestId('cats-copy-sub-s-own-padel')).toBeNull();
    fireEvent.click(screen.getByTestId('cats-copy-into-s-fam-sport'));
    fireEvent.click(screen.getByTestId('cats-copy-into-s-own-sport'));
    fireEvent.click(screen.getByTestId('cats-copy-commit'));

    await waitFor(
      async () => {
        const check = new MunniDB('munni_demo');
        const here = (await check.categories.toArray()).filter((r) => r.spaceId === DEMO_SPACE_ID && r.deleted === 0);
        check.close();
        const mains = here.filter((r) => r.isParent === 1 && r.name === 'Hobby');
        expect(mains).toHaveLength(1);
        const underHobby = here.filter((r) => r.parentId === mains[0].id);
        expect(underHobby.map((r) => r.name).sort()).toEqual(['Other', 'Paint']);
        expect(new Set(underHobby.map((r) => r.icon)).size).toBe(2);
        const underSport = here.filter((r) => r.parentId === 'sport');
        expect(underSport.map((r) => r.name).sort()).toEqual(['Padel', 'Squash']);
        expect(new Set(underSport.map((r) => r.icon)).size).toBe(2);
      },
      { timeout: 5000 },
    );
  });
});
