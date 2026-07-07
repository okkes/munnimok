import { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { BUILTIN_CATEGORIES, CATEGORY_BY_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import type { BuiltinCategory } from '@/domain/categories';
import type { CategoryRow, CatDirection, TxType } from '@/db/types';
import type { TFunc, TranslationKey } from '@/i18n';
import { useData } from '@/app/data';

/** A category at runtime: built-in (nameKey) or custom (name, synced row). */
export interface Cat extends Omit<BuiltinCategory, 'nameKey'> {
  nameKey?: string;
  /** user-entered name for custom categories */
  name?: string;
  custom?: boolean;
  /** the auto "Other" sub of a custom main (direction locked to 'both') */
  isOther?: boolean;
  /** space the custom row lives in (scope: personal space = user-scoped) */
  spaceId?: string;
}

export interface Catalog {
  all: Cat[];
  byId: (id: string | undefined) => Cat;
  childrenOf: (parentId: string) => Cat[];
  parents: Cat[];
  /** true when managing a shared space's categories (space scope) */
  sharedScope: boolean;
}

/** display name for either kind */
export function catName(cat: Cat, t: TFunc): string {
  return cat.name ?? (cat.nameKey ? t(cat.nameKey as TranslationKey) : cat.id);
}

const FALLBACK = CATEGORY_BY_ID.get(UNCATEGORIZED_ID)! as Cat;

const parentTxType = (row: CategoryRow, parentById: Map<string, CategoryRow>): TxType => {
  if (row.parentId) {
    const customParent = parentById.get(row.parentId);
    if (customParent) return customParent.txType;
    const builtinParent = CATEGORY_BY_ID.get(row.parentId);
    if (builtinParent) return builtinParent.txTypes[0];
  }
  return row.txType ?? 'expense';
};

function toCat(row: CategoryRow, parentById: Map<string, CategoryRow>): Cat {
  const isParent = row.isParent === 1;
  const txType = isParent ? (row.txType ?? 'expense') : parentTxType(row, parentById);
  const direction: CatDirection = isParent ? 'both' : row.isOther === 1 ? 'both' : (row.direction ?? 'both');
  return {
    id: row.id,
    parentId: row.parentId,
    name: row.name ?? row.id,
    icon: row.icon,
    // subs inherit the parent color at render time (color stays unset)
    color: isParent ? row.color || undefined : undefined,
    isParent,
    isOther: row.isOther === 1,
    txTypes: [txType],
    direction,
    custom: true,
    spaceId: row.spaceId,
  };
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

  const rows = useLiveQuery(async () => {
    const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
    const active = spaces.find((s) => s.id === spaceId);
    const visibleSpaceIds =
      active?.kind === 'shared'
        ? new Set([spaceId])
        : new Set(spaces.filter((s) => s.kind !== 'shared').map((s) => s.id));
    const cats = await db.categories.filter((c) => c.deleted === 0 && visibleSpaceIds.has(c.spaceId)).toArray();
    return { cats, sharedScope: active?.kind === 'shared' };
  }, [spaceId]);

  return useMemo(() => {
    const customRows = rows?.cats ?? [];
    const parentById = new Map(customRows.filter((r) => r.isParent === 1).map((r) => [r.id, r]));
    const custom: Cat[] = customRows
      .slice()
      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
      .map((row) => toCat(row, parentById));
    const all: Cat[] = [...(BUILTIN_CATEGORIES as Cat[]), ...custom];
    const map = new Map(all.map((c) => [c.id, c]));
    return {
      all,
      byId: (id) => (id && map.get(id)) || FALLBACK,
      childrenOf: (parentId) => all.filter((c) => c.parentId === parentId && !c.hidden),
      parents: all.filter((c) => c.isParent && !c.hidden),
      sharedScope: rows?.sharedScope ?? false,
    };
  }, [rows]);
}
