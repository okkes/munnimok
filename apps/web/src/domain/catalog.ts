import { CATEGORY_BY_ID, LOCKED_MAIN_IDS, UNCATEGORIZED_ID } from './categories';
import type { BuiltinCategory } from './categories';
import { mergedBuiltins } from './catalogDoc';
import type { CatalogDoc } from './catalogDoc';
import type { Lang } from '@/i18n';
import type { CatDirection, CategoryRow, SpaceRow, TxType } from '@/db/types';

/**
 * The category catalog, built purely from rows — shared by the React
 * hook (useCategories) and the service worker (budget alerts), which
 * cannot touch React.
 */

/** A category at runtime: built-in (nameKey) or custom (name, synced row). */
export interface Cat extends Omit<BuiltinCategory, 'nameKey'> {
  nameKey?: string;
  /** operator-published names (catalog document) — win over nameKey */
  names?: Record<Lang, string>;
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
  /** mains offered in pickers — per-space hidden mains filtered out */
  parents: Cat[];
  /** every main, hidden-per-space ones included (the manage screen) */
  allParents: Cat[];
  /** mains this space switched off (UI filtering only — data never blocks) */
  hiddenMains: ReadonlySet<string>;
  /** true when managing a shared space's categories (space scope) */
  sharedScope: boolean;
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
  // parents have no direction of their own; "Other" subs are locked to both
  const direction: CatDirection = isParent || row.isOther === 1 ? 'both' : (row.direction ?? 'both');
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

/** the custom rows visible from `spaceId`: the space's own only — every
 *  custom category belongs to the space it was created in (#387; the old
 *  rule let a personal space's categories show up in every other personal
 *  space). Another space's categories are COPIED over, never shared (#390). */
export function visibleCategoryRows(spaces: readonly SpaceRow[], rows: readonly CategoryRow[], spaceId: string): { rows: CategoryRow[]; sharedScope: boolean; hiddenMains: string[] } {
  const active = spaces.find((s) => s.id === spaceId);
  return {
    rows: rows.filter((c) => c.deleted === 0 && c.spaceId === spaceId),
    sharedScope: active?.kind === 'shared',
    hiddenMains: active?.hiddenMains ?? [],
  };
}

/** built-in catalog merged with the given custom rows (+ the fetched
 *  catalog document when the identity has one) */
export function buildCatalog(customRows: readonly CategoryRow[], sharedScope: boolean, hiddenMains: readonly string[] = [], doc?: CatalogDoc | null): Catalog {
  const parentById = new Map(customRows.filter((r) => r.isParent === 1).map((r) => [r.id, r]));
  const custom: Cat[] = customRows
    .slice()
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((row) => toCat(row, parentById));
  const all: Cat[] = [...(mergedBuiltins(doc) as Cat[]), ...custom];
  const map = new Map(all.map((c) => [c.id, c]));
  const off = new Set(hiddenMains);
  // #263 (user): everyday EXPENSE families lead every list; income next;
  // the ◆ special/system families sit below (stable within each band)
  const parentRank = (c: Cat): number => {
    if (LOCKED_MAIN_IDS.has(c.id)) return 2;
    return c.id === 'income' ? 1 : 0;
  };
  const childRank = (c: Cat): number => {
    if (c.isOther) return 2;
    return c.custom ? 1 : 0;
  };
  const allParents = all
    .filter((c) => c.isParent && !c.hidden)
    .sort((a, b) => parentRank(a) - parentRank(b));
  return {
    all,
    byId: (id) => (id && map.get(id)) || FALLBACK,
    // #388: the catalog's own subs keep their curated order, custom subs follow alphabetically, "Other" closes the list
    childrenOf: (parentId) =>
      all
        .filter((c) => c.parentId === parentId && !c.hidden)
        .sort((a, b) => childRank(a) - childRank(b) || (a.custom && b.custom ? (a.name ?? '').localeCompare(b.name ?? '', undefined, { sensitivity: 'base' }) : 0)),
    parents: allParents.filter((c) => !off.has(c.id)),
    allParents,
    hiddenMains: off,
    sharedScope,
  };
}
