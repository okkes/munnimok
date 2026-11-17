import { apiFetch } from '@/lib/api';
import type { StorageBackend } from '@/db/backend';
import type { CatalogDoc } from '@/domain/catalogDoc';
import { CATALOG_BASELINE } from '@/generated/catalogBaseline';

// only syncing identities call this: demo/offline keep the bundled baseline forever (zero-network promise)
export const CATALOG_META_KEY = 'catalog';
const ETAG_META_KEY = 'catalogEtag';

export async function refreshCatalog(store: StorageBackend): Promise<void> {
  const etag = (await store.metaGet(ETAG_META_KEY))?.value as string | undefined;
  const response = await apiFetch('/catalog', etag ? { headers: { 'If-None-Match': etag } } : undefined);
  if (response.status === 304) return;
  if (response.status === 204) {
    // the server has no document (fresh install / rollback): baseline rules
    await store.metaDelete(CATALOG_META_KEY);
    await store.metaDelete(ETAG_META_KEY);
    return;
  }
  if (!response.ok) return;
  const doc = (await response.json()) as CatalogDoc;
  await store.metaPut(CATALOG_META_KEY, doc);
  const nextEtag = response.headers.get('ETag');
  if (nextEtag) await store.metaPut(ETAG_META_KEY, nextEtag);
}

/** the fetched copy, else the baseline baked into the build; offline profiles live on that baseline forever */
export async function cachedCatalog(store: StorageBackend): Promise<CatalogDoc | null> {
  return ((await store.metaGet(CATALOG_META_KEY))?.value as CatalogDoc | undefined) ?? CATALOG_BASELINE;
}
