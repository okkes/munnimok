import type { StorageBackend } from '@/db/backend';
import type { Repo } from '@/db/repo';
import { tombstonedIds } from '@/domain/catalogDoc';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { cachedCatalog } from '@/sync/catalogSync';

/**
 * AC3: apply the catalog document's tombstones locally, once per
 * published version. Retired builtins detach their transactions (raw
 * rows and per-space overlays) to Uncategorized and put them back into
 * review — the same story as deleting a user category. Custom subs the
 * user created under a retired premade parent cascade away with it
 * (user ruling: "in that case we can't do much about it"); custom
 * categories are otherwise never touched by catalog updates.
 */
export async function applyCatalogTombstones(store: StorageBackend, repo: Repo): Promise<number> {
  const doc = await cachedCatalog(store);
  if (!doc) return 0;
  const dead = new Set(tombstonedIds(doc));
  if (dead.size === 0) return 0;
  const markerKey = `catalogDetach_v${doc.version}`;
  if (await store.metaGet(markerKey)) return 0;

  let touched = 0;
  // cascade: custom subs under a retired premade parent
  const orphans = (await store.allRows('category')).filter(
    (c) => c.deleted === 0 && !!c.parentId && dead.has(c.parentId),
  );
  for (const orphan of orphans) {
    await repo.remove('category', orphan.spaceId, orphan.id);
    dead.add(orphan.id); // their transactions detach in the same pass
    touched++;
  }
  for (const tx of await store.allRows('transaction')) {
    if (tx.deleted === 0 && tx.catId && dead.has(tx.catId)) {
      await repo.upsert('transaction', tx.spaceId, tx.id, { catId: UNCATEGORIZED_ID, needsReview: 1 });
      touched++;
    }
  }
  for (const meta of await store.allRows('txMeta')) {
    if (meta.deleted === 0 && meta.catId && dead.has(meta.catId)) {
      await repo.upsert('txMeta', meta.spaceId, meta.id, { catId: UNCATEGORIZED_ID, needsReview: 1 });
      touched++;
    }
  }
  await store.metaPut(markerKey, Date.now());
  return touched;
}
