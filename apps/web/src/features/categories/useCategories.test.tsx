// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useData } from '@/app/data';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { useLang } from '@/i18n';
import { renderWithData } from '@/test/harness';
import type { Catalog } from './useCategories';
import { catName, useCategories } from './useCategories';

let latest: Catalog | null = null;
let db: ReturnType<typeof useData>['db'] | null = null;
let spaceId = '';

function Probe() {
  const data = useData();
  const cats = useCategories();
  const { t } = useLang();
  latest = cats;
  db = data.db;
  spaceId = data.spaceId;
  return <div data-testid="probe">{catName(cats.byId('groceries'), t)}</div>;
}

describe('useCategories', () => {
  beforeEach(async () => {
    latest = null;
    db = null;
    localStorage.clear();
    sessionStorage.clear();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.deleteDatabase('munni_demo');
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
      req.onblocked = () => resolve();
    });
  });

  it('serves built-ins with localized names and safe fallbacks', async () => {
    renderWithData(<Probe />);
    expect((await screen.findByTestId('probe')).textContent).toBe('Grocery');
    expect(latest!.byId(undefined).id).toBe(UNCATEGORIZED_ID);
    expect(latest!.byId('never-existed').id).toBe(UNCATEGORIZED_ID);
    expect(latest!.parents.length).toBeGreaterThan(0);
    expect(latest!.parents.every((p) => p.isParent)).toBe(true);
    const kids = latest!.childrenOf(latest!.parents[0].id);
    expect(kids.every((k) => k.parentId === latest!.parents[0].id)).toBe(true);
  });

  it('merges custom space categories into the catalog', async () => {
    renderWithData(<Probe />);
    await screen.findByTestId('probe');
    await db!.categories.add({
      id: 'cat_custom1',
      spaceId,
      name: 'Padel',
      icon: 'tennis',
      color: '#123456',
      txType: 'expense',
      parentId: 'leisure',
      deleted: 0,
      fieldVersions: {},
    } as never);
    await waitFor(() => {
      const cat = latest!.byId('cat_custom1');
      expect(cat.custom).toBe(true);
      expect(cat.name).toBe('Padel');
      expect(cat.direction).toBe('debit');
    });
  });
});
