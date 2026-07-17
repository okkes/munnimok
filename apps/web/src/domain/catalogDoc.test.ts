import { describe, expect, it } from 'vitest';
import { buildCatalog } from './catalog';
import { mergedBuiltins, tombstonedIds } from './catalogDoc';
import type { CatalogDoc } from './catalogDoc';
import { predictCategory } from './predictCategory';

const doc = (over: Partial<CatalogDoc> = {}): CatalogDoc => ({
  version: 3,
  categories: [],
  keywords: [],
  ...over,
});

describe('catalog document overlay (admin-catalog AC1)', () => {
  it('no document -> the bundled baseline, untouched', () => {
    expect(mergedBuiltins(null)).toEqual(mergedBuiltins(undefined));
    const catalog = buildCatalog([], false, [], null);
    expect(catalog.byId('groceries').id).toBe('groceries');
  });

  it('renames a builtin in all three languages without touching the rest', () => {
    const d = doc({
      categories: [{ id: 'groceries', names: { en: 'Food shops', nl: 'Eten', tr: 'Gıda' }, icon: 'cart' }],
    });
    const merged = mergedBuiltins(d);
    const groceries = merged.find((c) => c.id === 'groceries')!;
    expect(groceries.names).toEqual({ en: 'Food shops', nl: 'Eten', tr: 'Gıda' });
    expect(groceries.icon).toBe('cart');
    // an untouched sibling keeps its bundled identity
    expect(merged.find((c) => c.id === 'salary')!.names).toBeUndefined();
  });

  it('adds a brand-new category with embedded names', () => {
    const d = doc({
      categories: [
        { id: 'padelClub', parentId: 'hobby', names: { en: 'Padel', nl: 'Padel', tr: 'Padel' }, icon: 'tennis', txTypes: ['expense'], direction: 'debit' },
      ],
    });
    const catalog = buildCatalog([], false, [], d);
    const added = catalog.byId('padelClub');
    expect(added.parentId).toBe('hobby');
    expect(added.names?.en).toBe('Padel');
    expect(catalog.childrenOf('hobby').some((c) => c.id === 'padelClub')).toBe(true);
  });

  it('a tombstone hides the category but keeps it renderable for history', () => {
    const d = doc({ categories: [{ id: 'gift', deleted: true, names: { en: 'Gift', nl: 'Cadeau', tr: 'Hediye' }, icon: 'gift-outline' }] });
    const catalog = buildCatalog([], false, [], d);
    // still resolvable (old transactions render their name) …
    expect(catalog.byId('gift').id).toBe('gift');
    // … but no longer offered anywhere
    expect(catalog.childrenOf(catalog.byId('gift').parentId!).some((c) => c.id === 'gift')).toBe(false);
    expect(tombstonedIds(d)).toEqual(['gift']);
  });

  it('published keyword rules replace the bundled set for prediction', () => {
    const rules = [{ catId: 'hobby', keywords: ['padelbaan'] }];
    expect(predictCategory('PADELBAAN AMSTERDAM', 'debit', rules)).toBe('hobby');
    // the bundled rule for the same text no longer applies
    expect(predictCategory('albert heijn', 'debit', rules)).toBeNull();
  });
});
