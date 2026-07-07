import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BUILTIN_CATEGORIES, CATEGORY_BY_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { BuiltinCategory } from '@/domain/categories';
import type { TFunc, TranslationKey } from '@/i18n';
import { useData } from '@/app/data';

/** A category at runtime: built-in (nameKey) or custom (name, synced row). */
export interface Cat extends Omit<BuiltinCategory, 'nameKey'> {
  nameKey?: string;
  /** user-entered name for custom categories */
  name?: string;
  custom?: boolean;
}

export interface Catalog {
  all: Cat[];
  byId: (id: string | undefined) => Cat;
  childrenOf: (parentId: string) => Cat[];
  parents: Cat[];
}

/** display name for either kind */
export function catName(cat: Cat, t: TFunc): string {
  return cat.name ?? (cat.nameKey ? t(cat.nameKey as TranslationKey) : cat.id);
}

const FALLBACK = CATEGORY_BY_ID.get(UNCATEGORIZED_ID)! as Cat;

/**
 * Built-in catalog merged with the active space's custom categories.
 * Custom categories are ordinary synced rows, so they flow to other
 * devices/members like any other data.
 */
export function useCategories(): Catalog {
  const { db, spaceId } = useData();
  const customRows = useLiveQuery(
    () => db.categories.where('spaceId').equals(spaceId).filter((c) => c.deleted === 0).toArray(),
    [spaceId],
  );

  return useMemo(() => {
    const custom: Cat[] = (customRows ?? []).map((row) => ({
      id: row.id,
      parentId: row.parentId,
      name: row.name ?? row.id,
      icon: row.icon,
      color: row.color || undefined,
      txTypes: [row.txType],
      direction: row.txType === 'income' ? 'credit' : row.txType === 'expense' ? 'debit' : 'both',
      custom: true,
    }));
    const all: Cat[] = [...(BUILTIN_CATEGORIES as Cat[]), ...custom];
    const map = new Map(all.map((c) => [c.id, c]));
    return {
      all,
      byId: (id) => (id && map.get(id)) || FALLBACK,
      childrenOf: (parentId) => all.filter((c) => c.parentId === parentId && !c.hidden),
      parents: all.filter((c) => c.isParent && !c.hidden),
    };
  }, [customRows]);
}
