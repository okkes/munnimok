import type { StorageBackend } from '@/db/backend';
import { apiFetch } from '@/lib/api';
import { clearNativeDeliveredNotifications } from '@/lib/platform';
import { clearInboxNow, clearInboxUpTo, readInboxClearedAt } from './notifications';

/**
 * #580: clearing the notifications list on one device clears it on the
 * person's other devices. The moment travels through the server (a clear
 * made offline goes out once the server is in reach); each device drops its
 * entries up to it and closes the OS notifications it still shows. Another
 * device follows when its list is next opened or the app comes back to the
 * foreground — not instantly: a push cannot carry a silent "clear" (web push
 * must show what it delivers, and iOS throttles silent pushes).
 */
const PENDING_KEY = 'notifClearPending';

/** a clear still waiting for the server has nowhere to go once the identity leaves its account */
export const forgetPendingClear = (store: Pick<StorageBackend, 'metaDelete'>): Promise<void> => store.metaDelete(PENDING_KEY);

/**
 * Closes the OS notifications this device still shows — the shell's own, or
 * the service worker's (those up to `upTo` when the browser dates them; a
 * remote clear leaves what arrived after it).
 */
export async function dismissDeliveredNotifications(upTo?: number): Promise<void> {
  if (await clearNativeDeliveredNotifications()) return;
  const registration = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
  const shown = (await registration?.getNotifications?.().catch(() => undefined)) ?? [];
  for (const notification of shown) {
    const at = (notification as Notification & { timestamp?: number }).timestamp;
    if (upTo === undefined || at === undefined || at <= upTo) notification.close();
  }
}

/** the Clear button: empties the list here, closes what the OS shows and — signed in — tells the other devices */
export async function clearNotifications(store: StorageBackend, syncing: boolean): Promise<void> {
  await clearInboxNow(store);
  await dismissDeliveredNotifications();
  if (!syncing) return;
  await store.metaPut(PENDING_KEY, true);
  await syncNotificationsCleared(store);
}

/** brings this device and the server to the same moment; true when a clear made elsewhere took entries away here */
export async function syncNotificationsCleared(store: StorageBackend): Promise<boolean> {
  const pending = (await store.metaGet(PENDING_KEY))?.value === true;
  const local = await readInboxClearedAt(store);
  const res =
    pending && local
      ? await apiFetch('/me/notifications/cleared', {
          method: 'PUT',
          body: JSON.stringify({ clearedAt: local }),
        }).catch(() => null)
      : await apiFetch('/me/notifications/cleared').catch(() => null);
  if (!res?.ok) return false; // offline: a pending clear goes out on the next try
  if (pending) await store.metaPut(PENDING_KEY, false);
  const body = (await res.json().catch(() => null)) as {
    clearedAt?: unknown;
  } | null;
  if (typeof body?.clearedAt !== 'string') return false;
  const at = new Date(body.clearedAt);
  if (Number.isNaN(at.getTime())) return false;
  if (!(await clearInboxUpTo(store, at.toISOString()))) return false;
  await dismissDeliveredNotifications(at.getTime());
  return true;
}
