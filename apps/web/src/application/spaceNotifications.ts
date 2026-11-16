import type { StorageBackend } from '@/db/backend';
import { apiFetch } from '@/lib/api';
import { forgetPendingClear } from './inboxClear';

// #549: the choice is the person's own (not space data: a reader makes it too, nothing is logged); the server keeps it
// because it decides which pushes go out, the device mirrors it so its own alerts follow it offline; unset = notifies
type MetaStore = Pick<StorageBackend, 'metaGet' | 'metaPut'>;

const OFF_KEY = 'notifyOffSpaces';

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

// going offline keeps this store for the new profile: the old server's list would mute spaces no switch reaches
export async function forgetSpacesNotifyOff(store: Pick<StorageBackend, 'metaDelete'>): Promise<void> {
  await store.metaDelete(OFF_KEY);
  await forgetPendingClear(store);
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

/** the in-app list records the event either way: it is the app's own record, not an interruption */
export async function osNotifyAllowed(store: MetaStore, spaceId: string): Promise<boolean> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return false;
  return spaceNotifyOn(store, spaceId);
}
