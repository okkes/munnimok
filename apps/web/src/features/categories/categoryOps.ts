import { CATEGORY_BY_ID } from '@/domain/categories';
import {
  affectedByDelete,
  affectedByDirectionChange,
  affectedByTypeChange,
  detachCategoryPatch,
} from '@/domain/categoryRules';
import { historyTransactions, writeTxTransform } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import type { CategoryRow, CatDirection, SpaceRow, TxType } from '@/db/types';
import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';

/**
 * Category edit/delete with impact analysis. Edits that break existing
 * category assignments (type change, direction change, moving a sub to
 * a parent of another type, deletion) first report how many
 * transactions are affected so the UI can warn; committing detaches
 * those transactions to Uncategorized + review. All writes go through
 * the Repo so they sync like any other change.
 */

export interface CategoryChanges {
  name?: string;
  icon?: string;
  color?: string;
  txType?: TxType;
  direction?: CatDirection;
  parentId?: string;
}

export interface PendingCommit {
  affected: SpaceTx[];
  commit: () => Promise<void>;
}

/** spaces whose transactions can reference this category: its own (#387 — a custom category belongs to the space it was created in) */
async function visibleSpaceIds(_store: StorageBackend, row: CategoryRow): Promise<string[]> {
  return [row.spaceId];
}

/** #389: sub-categories under one main must not share an icon — the icon is the row's face in every list */
export const iconConflict = (
  candidate: { icon: string; parentId?: string; selfId?: string },
  rows: readonly { id: string; icon: string; parentId?: string }[],
): boolean =>
  !!candidate.parentId && rows.some((r) => r.parentId === candidate.parentId && r.id !== candidate.selfId && r.icon === candidate.icon);

/** one thing the copy sheet offers: a custom main with its subs, or a lone sub under a catalog main */
export interface CopyUnit {
  row: CategoryRow;
  subs: CategoryRow[];
  space: SpaceRow;
}

/**
 * #390: the custom categories of the user's OTHER spaces that this space
 * does not have yet — grouped as copy units (a custom main comes with every
 * sub of its own; a sub under a catalog main comes alone). "Has already" is
 * decided by name: a main of the same name, or a sub of the same name under
 * the same catalog main. Rows of the active space never appear.
 */
export function copyableUnits(spaceId: string, spaces: readonly SpaceRow[], rows: readonly CategoryRow[]): CopyUnit[] {
  const live = rows.filter((r) => r.deleted === 0);
  const here = live.filter((r) => r.spaceId === spaceId);
  const norm = (name?: string) => (name ?? '').trim().toLowerCase();
  const hereMains = new Set(here.filter((r) => r.isParent === 1).map((r) => norm(r.name)));
  const hereSubs = new Set(here.filter((r) => r.isParent !== 1).map((r) => `${r.parentId}|${norm(r.name)}`));
  const units: CopyUnit[] = [];
  const spaceById = new Map(spaces.filter((sp) => sp.deleted === 0).map((sp) => [sp.id, sp]));
  const custom = new Set(live.filter((r) => r.isParent === 1).map((r) => r.id));
  for (const row of live) {
    if (row.spaceId === spaceId || row.isOther === 1) continue;
    const space = spaceById.get(row.spaceId);
    if (!space) continue;
    if (row.isParent === 1) {
      if (hereMains.has(norm(row.name))) continue;
      units.push({ row, subs: live.filter((r) => r.parentId === row.id && r.isOther !== 1), space });
    } else if (row.parentId && !custom.has(row.parentId)) {
      // a sub under a catalog main (a sub of a custom main travels with its main)
      if (hereSubs.has(`${row.parentId}|${norm(row.name)}`)) continue;
      units.push({ row, subs: [], space });
    }
  }
  return units.sort((a, b) => a.space.name.localeCompare(b.space.name) || (a.row.name ?? '').localeCompare(b.row.name ?? ''));
}

/** every transaction those spaces SEE — own rows and attached feeds,
 *  gates lifted, with the view's DERIVED types (a category conflict is
 *  a view-level fact: nothing stores a type) */
async function txsInSpaces(store: StorageBackend, spaceIds: string[]): Promise<SpaceTx[]> {
  const out: SpaceTx[] = [];
  for (const spaceId of spaceIds) out.push(...(await historyTransactions(store, spaceId)));
  return out;
}

const parentTypeOf = async (store: StorageBackend, parentId: string): Promise<TxType> => {
  const builtin = CATEGORY_BY_ID.get(parentId);
  if (builtin) return builtin.txTypes[0];
  const custom = await store.get('category', parentId);
  return custom?.txType ?? 'expense';
};

/** #244 (user): direction left the user's hands — a sub simply follows
 *  its parent's nature. Income subs are credit, expense subs debit;
 *  anything else (legacy custom mains of other types) stays open. */
export const directionForType = (txType: TxType): CatDirection => {
  if (txType === 'income') return 'credit';
  return txType === 'expense' ? 'debit' : 'both';
};

/** the space's opinion is what detaches: in place on own rows, on the
 *  overlay for feed rows (the ONE write path) */
async function detachAll(repo: Repo, affected: SpaceTx[], catIds: Set<string>): Promise<void> {
  for (const tx of affected) {
    await writeTxTransform(repo, tx, detachCategoryPatch(tx, catIds));
  }
}

/** subs of a custom parent (non-deleted, same space) */
export async function subsOf(store: StorageBackend, parent: CategoryRow): Promise<CategoryRow[]> {
  return (await store.allRows('category')).filter((c) => c.deleted === 0 && c.parentId === parent.id);
}

interface EditImpact {
  affected: SpaceTx[];
  detachIds: Set<string>;
  /** the sub's new inherited type when it moves under another parent */
  movedType?: TxType;
}

const addBroken = (impact: EditImpact, broken: SpaceTx[], catIds: Iterable<string>) => {
  if (broken.length === 0) return;
  for (const tx of broken) {
    if (!impact.affected.some((a) => a.id === tx.id)) impact.affected.push(tx);
  }
  for (const id of catIds) impact.detachIds.add(id);
};

/** rule 1: type change on a parent breaks every differently-typed tx in the subtree */
const typeChangeImpact = (impact: EditImpact, txs: SpaceTx[], row: CategoryRow, changes: CategoryChanges, subtree: Set<string>) => {
  if (row.isParent !== 1 || !changes.txType || changes.txType === row.txType) return;
  addBroken(impact, affectedByTypeChange(txs, subtree, changes.txType), subtree);
};

/** rule 2: direction change on a sub breaks wrong-side txs */
const directionChangeImpact = (impact: EditImpact, txs: SpaceTx[], row: CategoryRow, changes: CategoryChanges) => {
  if (row.isParent === 1 || !changes.direction || changes.direction === (row.direction ?? 'both')) return;
  addBroken(impact, affectedByDirectionChange(txs, row.id, changes.direction), [row.id]);
};

/** rule 3: moving a sub under a parent of another type breaks differently-typed txs */
const moveImpact = async (impact: EditImpact, store: StorageBackend, txs: SpaceTx[], row: CategoryRow, changes: CategoryChanges) => {
  if (row.isParent === 1 || !changes.parentId || changes.parentId === row.parentId) return;
  impact.movedType = await parentTypeOf(store, changes.parentId);
  if (impact.movedType === row.txType) return;
  addBroken(impact, affectedByTypeChange(txs, new Set([row.id]), impact.movedType), [row.id]);
};

/**
 * Prepare an edit. `affected` is what the warning shows; `commit`
 * detaches those transactions and saves the change (type changes on a
 * parent propagate the stored txType to its subs for consistency).
 */
export async function prepareCategoryEdit(
  store: StorageBackend,
  repo: Repo,
  row: CategoryRow,
  changes: CategoryChanges,
): Promise<PendingCommit> {
  const txs = await txsInSpaces(store, await visibleSpaceIds(store, row));
  const subs = row.isParent === 1 ? await subsOf(store, row) : [];
  const subtree = new Set([row.id, ...subs.map((s) => s.id)]);

  const impact: EditImpact = { affected: [], detachIds: new Set() };
  typeChangeImpact(impact, txs, row, changes, subtree);
  directionChangeImpact(impact, txs, row, changes);
  await moveImpact(impact, store, txs, row, changes);

  return {
    affected: impact.affected,
    commit: async () => {
      if (impact.detachIds.size > 0) await detachAll(repo, impact.affected, impact.detachIds);
      const patch: Partial<CategoryRow> = { ...changes };
      // #244: a moved sub follows its NEW parent's nature — type and
      // direction both re-derive (the user never states either)
      if (impact.movedType) {
        patch.txType = impact.movedType;
        patch.direction = directionForType(impact.movedType);
      }
      await repo.upsert('category', row.spaceId, row.id, patch);
      // keep stored txType on subs consistent with the parent
      if (row.isParent === 1 && changes.txType && changes.txType !== row.txType) {
        for (const sub of subs) {
          await repo.upsert('category', sub.spaceId, sub.id, { txType: changes.txType });
        }
      }
    },
  };
}

/** Prepare a delete: parents cascade to their subs; users get detached. */
export async function prepareCategoryDelete(store: StorageBackend, repo: Repo, row: CategoryRow): Promise<PendingCommit> {
  const subs = row.isParent === 1 ? await subsOf(store, row) : [];
  const subtree = new Set([row.id, ...subs.map((s) => s.id)]);
  const txs = await txsInSpaces(store, await visibleSpaceIds(store, row));
  const affected = affectedByDelete(txs, subtree);
  return {
    affected,
    commit: async () => {
      await detachAll(repo, affected, subtree);
      for (const sub of subs) await repo.remove('category', sub.spaceId, sub.id);
      await repo.remove('category', row.spaceId, row.id);
    },
  };
}

/** Create a custom main category with its locked "Other" sub. */
export async function createMainCategory(
  repo: Repo,
  spaceId: string,
  input: { name: string; icon: string; color: string; txType: TxType; otherName: string },
): Promise<string> {
  const id = repo.newId();
  await repo.upsert('category', spaceId, id, {
    name: input.name,
    icon: input.icon,
    color: input.color,
    txType: input.txType,
    isParent: 1,
    sortOrder: 999,
    builtin: 0,
  });
  await repo.upsert('category', spaceId, repo.newId(), {
    parentId: id,
    name: input.otherName,
    icon: input.icon,
    color: '',
    txType: input.txType,
    direction: 'both',
    isOther: 1,
    sortOrder: 9999,
    builtin: 0,
  });
  return id;
}

/** Create a custom sub under any parent (type AND direction inherited
 *  from the parent — #244: the user never states a direction). */
export async function createSubCategory(
  store: StorageBackend,
  repo: Repo,
  spaceId: string,
  input: { parentId: string; name: string; icon: string },
): Promise<string> {
  const id = repo.newId();
  const txType = await parentTypeOf(store, input.parentId);
  await repo.upsert('category', spaceId, id, {
    parentId: input.parentId,
    name: input.name,
    icon: input.icon,
    color: '',
    txType,
    direction: directionForType(txType),
    sortOrder: 999,
    builtin: 0,
  });
  return id;
}

/** the copyable payload of a category row (fresh envelope on the target) */
const categoryCopyFields = (r: CategoryRow, overrides: Partial<CategoryRow>): Record<string, unknown> => ({
  parentId: r.parentId,
  name: r.name,
  icon: r.icon,
  color: r.color,
  txType: r.txType,
  direction: r.direction,
  isParent: r.isParent,
  isOther: r.isOther,
  sortOrder: r.sortOrder,
  builtin: 0,
  ...overrides,
});

/**
 * Copy a personal (user-scoped) category into a shared space. Parents
 * are copied with their whole subtree; a sub under a builtin parent is
 * copied alone. Transactions are not touched.
 */
export async function copyCategoryToSpace(
  store: StorageBackend,
  repo: Repo,
  targetSpaceId: string,
  row: CategoryRow,
): Promise<void> {
  if (row.isParent === 1) {
    const newParentId = repo.newId();
    await repo.upsert('category', targetSpaceId, newParentId, categoryCopyFields(row, { parentId: undefined }));
    for (const sub of await subsOf(store, row)) {
      await repo.upsert('category', targetSpaceId, repo.newId(), categoryCopyFields(sub, { parentId: newParentId }));
    }
  } else {
    await repo.upsert('category', targetSpaceId, repo.newId(), categoryCopyFields(row, {}));
  }
}
