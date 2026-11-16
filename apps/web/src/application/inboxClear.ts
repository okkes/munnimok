import type { StorageBackend } from '@/db/backend';
import { apiFetch } from '@/lib/api';
import { clearNativeDeliveredNotifications } from '@/lib/platform';
import { clearInboxNow, clearInboxUpTo, readInboxClearedAt } from './notifications';

// #580: a clear travels through the server (offline, it goes out later); other devices follow on list open or foreground
// not by push: web push must show what it delivers and iOS throttles silent pushes
const PENDING_KEY = 'notifClearPending';

/** a clear still waiting for the server has nowhere to go once the identity leaves its account */
export const forgetPendingClear = (store: Pick<StorageBackend, 'metaDelete'>): Promise<void> => store.metaDelete(PENDING_KEY);

/** `upTo`: only notifications the browser dates up to it close; a remote clear leaves later arrivals */
export async function dismissDeliveredNotifications(upTo?: number): Promise<void> {
  if (await clearNativeDeliveredNotifications()) return;
  const registration = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
  const shown = (await registration?.getNotifications?.().catch(() => undefined)) ?? [];
  for (const notification of shown) {
    const at = (notification as Notification & { timestamp?: number }).timestamp;
    if (upTo === undefined || at === undefined || at <= upTo) notification.close();
  }
}

export async function clearNotifications(store: StorageBackend, syncing: boolean): Promise<void> {
  await clearInboxNow(store);
  await dismissDeliveredNotifications();
  if (!syncing) return;
  await store.metaPut(PENDING_KEY, true);
  await syncNotificationsCleared(store);
}

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
