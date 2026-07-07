import { CATEGORY_BY_ID } from '@/domain/categories';
import {
  affectedByDelete,
  affectedByDirectionChange,
  affectedByTypeChange,
  detachCategoryPatch,
} from '@/domain/categoryRules';
import type { CategoryRow, CatDirection, TransactionRow, TxType } from '@/db/types';
import type { MunniDB } from '@/db/schema';
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
  affected: TransactionRow[];
  commit: () => Promise<void>;
}

/** spaces whose transactions can reference this category (its visibility) */
async function visibleSpaceIds(db: MunniDB, row: CategoryRow): Promise<string[]> {
  const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
  const home = spaces.find((s) => s.id === row.spaceId);
  if (home?.kind === 'shared') return [row.spaceId];
  return spaces.filter((s) => s.kind !== 'shared').map((s) => s.id);
}

async function txsInSpaces(db: MunniDB, spaceIds: string[]): Promise<TransactionRow[]> {
  const ids = new Set(spaceIds);
  return db.transactions.filter((t) => t.deleted === 0 && ids.has(t.spaceId)).toArray();
}

const parentTypeOf = async (db: MunniDB, parentId: string): Promise<TxType> => {
  const builtin = CATEGORY_BY_ID.get(parentId);
  if (builtin) return builtin.txTypes[0];
  const custom = await db.categories.get(parentId);
  return custom?.txType ?? 'expense';
};

async function detachAll(repo: Repo, affected: TransactionRow[], catIds: Set<string>): Promise<void> {
  for (const tx of affected) {
    await repo.upsert('transaction', tx.spaceId, tx.id, detachCategoryPatch(tx, catIds));
  }
}

/** subs of a custom parent (non-deleted, same space) */
export async function subsOf(db: MunniDB, parent: CategoryRow): Promise<CategoryRow[]> {
  return db.categories.filter((c) => c.deleted === 0 && c.parentId === parent.id).toArray();
}

/**
 * Prepare an edit. `affected` is what the warning shows; `commit`
 * detaches those transactions and saves the change (type changes on a
 * parent propagate the stored txType to its subs for consistency).
 */
export async function prepareCategoryEdit(
  db: MunniDB,
  repo: Repo,
  row: CategoryRow,
  changes: CategoryChanges,
): Promise<PendingCommit> {
  const txs = await txsInSpaces(db, await visibleSpaceIds(db, row));
  const affected: TransactionRow[] = [];
  const detachIds = new Set<string>();

  const isParent = row.isParent === 1;
  const subs = isParent ? await subsOf(db, row) : [];
  const subtree = new Set([row.id, ...subs.map((s) => s.id)]);

  // 1) type change on a parent breaks every differently-typed tx in the subtree
  if (isParent && changes.txType && changes.txType !== row.txType) {
    const broken = affectedByTypeChange(txs, subtree, changes.txType);
    if (broken.length > 0) {
      affected.push(...broken);
      subtree.forEach((id) => detachIds.add(id));
    }
  }

  // 2) direction change on a sub breaks wrong-side txs
  if (!isParent && changes.direction && changes.direction !== (row.direction ?? 'both')) {
    for (const tx of affectedByDirectionChange(txs, row.id, changes.direction)) {
      if (!affected.some((a) => a.id === tx.id)) affected.push(tx);
      detachIds.add(row.id);
    }
  }

  // 3) moving a sub under a parent of another type breaks differently-typed txs
  let movedType: TxType | undefined;
  if (!isParent && changes.parentId && changes.parentId !== row.parentId) {
    movedType = await parentTypeOf(db, changes.parentId);
    if (movedType !== row.txType) {
      for (const tx of affectedByTypeChange(txs, new Set([row.id]), movedType)) {
        if (!affected.some((a) => a.id === tx.id)) affected.push(tx);
        detachIds.add(row.id);
      }
    }
  }

  return {
    affected,
    commit: async () => {
      if (detachIds.size > 0) await detachAll(repo, affected, detachIds);
      const patch: Partial<CategoryRow> = { ...changes };
      if (movedType) patch.txType = movedType;
      await repo.upsert('category', row.spaceId, row.id, patch as Record<string, unknown>);
      // keep stored txType on subs consistent with the parent
      if (isParent && changes.txType && changes.txType !== row.txType) {
        for (const sub of subs) {
          await repo.upsert('category', sub.spaceId, sub.id, { txType: changes.txType });
        }
      }
    },
  };
}

/** Prepare a delete: parents cascade to their subs; users get detached. */
export async function prepareCategoryDelete(db: MunniDB, repo: Repo, row: CategoryRow): Promise<PendingCommit> {
  const subs = row.isParent === 1 ? await subsOf(db, row) : [];
  const subtree = new Set([row.id, ...subs.map((s) => s.id)]);
  const txs = await txsInSpaces(db, await visibleSpaceIds(db, row));
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

/** Create a custom sub under any parent (type inherited from the parent). */
export async function createSubCategory(
  db: MunniDB,
  repo: Repo,
  spaceId: string,
  input: { parentId: string; name: string; icon: string; direction: CatDirection },
): Promise<string> {
  const id = repo.newId();
  await repo.upsert('category', spaceId, id, {
    parentId: input.parentId,
    name: input.name,
    icon: input.icon,
    color: '',
    txType: await parentTypeOf(db, input.parentId),
    direction: input.direction,
    sortOrder: 999,
    builtin: 0,
  });
  return id;
}

/**
 * Copy a personal (user-scoped) category into a shared space. Parents
 * are copied with their whole subtree; a sub under a builtin parent is
 * copied alone. Transactions are not touched.
 */
export async function copyCategoryToSpace(
  db: MunniDB,
  repo: Repo,
  targetSpaceId: string,
  row: CategoryRow,
): Promise<void> {
  const strip = (r: CategoryRow, overrides: Partial<CategoryRow>): Record<string, unknown> => ({
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
  if (row.isParent === 1) {
    const newParentId = repo.newId();
    await repo.upsert('category', targetSpaceId, newParentId, strip(row, { parentId: undefined }));
    for (const sub of await subsOf(db, row)) {
      await repo.upsert('category', targetSpaceId, repo.newId(), strip(sub, { parentId: newParentId }));
    }
  } else {
    await repo.upsert('category', targetSpaceId, repo.newId(), strip(row, {}));
  }
}
