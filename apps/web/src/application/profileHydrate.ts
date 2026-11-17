import { apiFetch } from '@/lib/api';
import type { StorageBackend } from '@/db/backend';

/** the Settings avatar reads the local profile copy that only Save wrote: hydrate it from /me when missing */
export async function hydrateProfileMeta(store: StorageBackend): Promise<void> {
  if ((await store.metaGet('profile'))?.value) return;
  const res = await apiFetch('/me').catch(() => null);
  if (!res?.ok) return; // offline: try again next open
  const me = (await res.json()) as { displayName?: string | null; picture?: string | null; country?: string | null };
  if (!me.displayName && !me.picture) return;
  await store.metaPut('profile', { name: me.displayName ?? '', picture: me.picture ?? undefined, country: me.country ?? undefined });
}
