import type { StorageBackend } from '@/db/backend';
import { apiFetch } from '@/lib/api';

/**
 * #549: notifications are chosen per space — the person's own choice (not
 * the space's data, so a reader makes it too and nothing is logged), kept by
 * the server because it decides which pushes go out, and mirrored here so
 * the device's own alerts (budgets, the plan, reminders, the digest) follow
 * it offline as well. A space nobody switched off notifies.
 */
type MetaStore = Pick<StorageBackend, 'metaGet' | 'metaPut'>;

const OFF_KEY = 'notifyOffSpaces';

/** the spaces switched off, as this device last heard */
export async function readSpacesNotifyOff(store: MetaStore): Promise<string[]> {
  const value = (await store.metaGet(OFF_KEY))?.value;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}

export async function spaceNotifyOn(store: MetaStore, spaceId: string): Promise<boolean> {
  return !(await readSpacesNotifyOff(store)).includes(spaceId);
}

/** the server's list into the mirror; null when it could not answer (the mirror stays as it was) */
export async function refreshSpacesNotifyOff(store: MetaStore): Promise<string[] | null> {
  const res = await apiFetch('/me/space-notifications').catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { off?: unknown } | null;
  if (!Array.isArray(body?.off)) return null;
  const off = body.off.filter((id): id is string => typeof id === 'string');
  await store.metaPut(OFF_KEY, off);
  return off;
}

/** switches one space's notifications; false when the server did not take it — nothing changes then */
export async function setSpaceNotify(store: MetaStore, spaceId: string, on: boolean): Promise<boolean> {
  const res = await apiFetch(`/me/space-notifications/${encodeURIComponent(spaceId)}`, {
    method: 'PUT',
    body: JSON.stringify({ on }),
  }).catch(() => null);
  if (!res?.ok) return false;
  const others = (await readSpacesNotifyOff(store)).filter((id) => id !== spaceId);
  await store.metaPut(OFF_KEY, on ? others : [...others, spaceId]);
  return true;
}

/**
 * Whether the device may show an OS notification about one space: the
 * browser allows it and the space is not switched off. The in-app list
 * records the event either way — it is the app's own record, not an
 * interruption.
 */
export async function osNotifyAllowed(store: MetaStore, spaceId: string): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  return spaceNotifyOn(store, spaceId);
}
