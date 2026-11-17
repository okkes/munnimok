import type { StorageBackend } from '@/db/backend';
import { apiFetch } from '@/lib/api';
import { clearNativeDeliveredNotifications } from '@/lib/platform';
import { closeShownOfScopes } from './deliveredNotifications';
import { shownTagOf } from './inboxResolve';
import { clearInboxUpTo, clearScopeUpTo, clearScopesNow, readClearedBy, readInboxClearedAt } from './notifications';
import type { InboxEntry } from './notifications';

// #580: a clear travels through the server (offline, it goes out later); other devices follow on list open or foreground
// not by push: web push must show what it delivers and iOS throttles silent pushes
// #614: Clear takes the parts of the list the bell showed; `true` is a whole-list clear an older build left waiting
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

const tagsOf = (rows: readonly InboxEntry[]): Set<string> => new Set(rows.flatMap((row) => shownTagOf(row) ?? []));

async function pendingScopes(store: Pick<StorageBackend, 'metaGet'>): Promise<string[]> {
  const value = (await store.metaGet(PENDING_KEY))?.value;
  return Array.isArray(value) ? value.filter((scope): scope is string => typeof scope === 'string') : [];
}

export async function clearNotifications(store: StorageBackend, syncing: boolean, scopes: readonly string[]): Promise<void> {
  const dropped = await clearScopesNow(store, scopes);
  await closeShownOfScopes(store, scopes, tagsOf(dropped));
  if (!syncing) return;
  await store.metaPut(PENDING_KEY, [...new Set([...(await pendingScopes(store)), ...scopes])]);
  await syncNotificationsCleared(store);
}

interface ClearedAnswer {
  clearedAt?: unknown;
  scopes?: unknown;
}

const put = (body: object) => apiFetch('/me/notifications/cleared', { method: 'PUT', body: JSON.stringify(body) }).catch(() => null);

/** what this device still owes the server; null when the server could not be told (it goes out on the next try) */
async function sendPending(store: StorageBackend): Promise<Response | null | undefined> {
  const waiting = (await store.metaGet(PENDING_KEY))?.value;
  if (waiting === true) {
    const whole = await readInboxClearedAt(store);
    return whole ? put({ clearedAt: whole }) : undefined;
  }
  const scopes = await pendingScopes(store);
  if (scopes.length === 0) return undefined;
  // parts cleared in one press share their moment: one request per moment
  const clearedBy = await readClearedBy(store);
  const byMoment = new Map<string, string[]>();
  for (const scope of scopes) {
    const at = clearedBy[scope];
    if (at) byMoment.set(at, [...(byMoment.get(at) ?? []), scope]);
  }
  let last: Response | null | undefined;
  for (const [clearedAt, sent] of byMoment) {
    last = await put({ clearedAt, scopes: sent });
    if (!last?.ok) return null;
  }
  return last;
}

const instant = (value: unknown): Date | null => {
  if (typeof value !== 'string') return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
};

export async function syncNotificationsCleared(store: StorageBackend): Promise<boolean> {
  const sent = await sendPending(store);
  if (sent === null) return false;
  const res = sent ?? (await apiFetch('/me/notifications/cleared').catch(() => null));
  if (!res?.ok) return false; // offline: a pending clear goes out on the next try
  if (sent) await store.metaPut(PENDING_KEY, false);
  const body = (await res.json().catch(() => null)) as ClearedAnswer | null;

  let moved = false;
  const whole = instant(body?.clearedAt);
  if (whole && (await clearInboxUpTo(store, whole.toISOString()))) {
    await dismissDeliveredNotifications(whole.getTime());
    moved = true;
  }
  const parts = body?.scopes && typeof body.scopes === 'object' ? Object.entries(body.scopes) : [];
  for (const [scope, value] of parts) {
    const at = instant(value);
    const dropped = at ? await clearScopeUpTo(store, scope, at.toISOString()) : null;
    if (!at || dropped === null) continue;
    await closeShownOfScopes(store, [scope], tagsOf(dropped), at.getTime());
    moved = true;
  }
  return moved;
}
