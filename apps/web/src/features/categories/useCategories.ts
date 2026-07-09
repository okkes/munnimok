import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { buildCatalog, visibleCategoryRows } from '@/domain/catalog';
import type { Cat, Catalog } from '@/domain/catalog';
import type { TFunc, TranslationKey } from '@/i18n';
import { useData } from '@/app/data';

// the catalog itself is pure domain code (domain/catalog.ts) so the
// service worker can build it too; this hook only adds the live query
export type { Cat, Catalog } from '@/domain/catalog';

/** display name for either kind */
export function catName(cat: Cat, t: TFunc): string {
  return cat.name ?? (cat.nameKey ? t(cat.nameKey as TranslationKey) : cat.id);
}

/**
 * Built-in catalog merged with the visible custom categories.
 *
 * Scope rule (matches the legacy app): categories created in a personal
 * space are user-scoped — visible across ALL the user's personal
 * spaces; categories created in a shared space belong to that space
 * only. Custom rows are ordinary synced data either way.
 */
export function useCategories(): Catalog {
  const { db, spaceId } = useData();

  const visible = useLiveQuery(async () => {
    const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
    const cats = await db.categories.filter((c) => c.deleted === 0).toArray();
    return visibleCategoryRows(spaces, cats, spaceId);
  }, [spaceId]);

  return useMemo(() => buildCatalog(visible?.rows ?? [], visible?.sharedScope ?? false), [visible]);
}
