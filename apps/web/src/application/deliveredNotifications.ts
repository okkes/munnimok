import type { StorageBackend } from '@/db/backend';
import { nativeDelivered, removeNativeDelivered } from '@/lib/platform';
import type { NativeDelivered } from '@/lib/platform';
import { buildNotification } from '@/sync/swNotifications';
import type { PushPayload } from '@/sync/swNotifications';
import { GENERAL_SCOPE } from './notifications';

/** #614: one notification the device still shows — the browser's (shown by the worker) or the phone's own (delivered by FCM) */
export interface ShownNotification {
  tag: string;
  /** when the browser dates it; a phone does not say */
  at?: number;
  close: () => Promise<void>;
}

// Android files a push under the tag the server gave it (FcmTexts.Tag) and keeps no data; iOS has no tag and hands
// back the push's data, from which the worker's own rule gives the same tag
function nativeTag(delivered: NativeDelivered): string | undefined {
  if (delivered.tag && !delivered.tag.startsWith('FCM-Notification')) return delivered.tag;
  const raw = delivered.data?.payload;
  if (typeof raw !== 'string') return undefined;
  try {
    return buildNotification(JSON.parse(raw) as PushPayload, 'en')?.tag;
  } catch {
    return undefined;
  }
}

export async function shownNotifications(): Promise<ShownNotification[]> {
  const native = await nativeDelivered();
  if (native) {
    return native.flatMap((delivered) => {
      const tag = nativeTag(delivered);
      return tag ? [{ tag, close: () => removeNativeDelivered([delivered]) }] : [];
    });
  }
  const registration = await navigator.serviceWorker?.getRegistration?.().catch(() => undefined);
  const shown = (await registration?.getNotifications?.().catch(() => undefined)) ?? [];
  return shown.flatMap((notification) =>
    notification.tag
      ? [{ tag: notification.tag, at: (notification as Notification & { timestamp?: number }).timestamp, close: () => Promise.resolve(notification.close()) }]
      : [],
  );
}

export async function closeShownWhere(goes: (tag: string) => boolean): Promise<void> {
  for (const shown of await shownNotifications()) if (goes(shown.tag)) await shown.close();
}

const ABOUT_NO_SPACE = /^(friend-request|friend-accept|space-invite|space-join|member-removed|member-role|test)$|^split-/;
const PLAN_TAG = /^plan-(.+)-\d{4}-\d{2}-\d{2}$/;
const BUDGET_TAG = /^budget-(.+)-\d{4}-\d{2}-\d{2}$/;

/** the part of the bell a shown notification belongs to; undefined when its tag does not say */
export async function scopeOfTag(store: StorageBackend, tag: string): Promise<string | undefined> {
  if (ABOUT_NO_SPACE.test(tag)) return GENERAL_SCOPE;
  if (tag.startsWith('new-tx-')) return tag === 'new-tx-all' ? undefined : tag.slice('new-tx-'.length);
  const plan = PLAN_TAG.exec(tag)?.[1];
  if (plan) return plan;
  const budget = BUDGET_TAG.exec(tag)?.[1];
  if (budget) return (await store.get('budget', budget))?.spaceId;
  if (tag.startsWith('rec-remind-')) return (await store.get('recurring', tag.slice('rec-remind-'.length)))?.spaceId;
  return undefined;
}

/** closes what the device shows of these parts of the bell, plus the named tags; `upTo` leaves what the browser dates later */
export async function closeShownOfScopes(
  store: StorageBackend,
  scopes: readonly string[],
  alsoTags: ReadonlySet<string>,
  upTo?: number,
): Promise<void> {
  for (const shown of await shownNotifications()) {
    if (upTo !== undefined && shown.at !== undefined && shown.at > upTo) continue;
    const scope = alsoTags.has(shown.tag) ? undefined : await scopeOfTag(store, shown.tag);
    if (alsoTags.has(shown.tag) || (scope !== undefined && scopes.includes(scope))) await shown.close();
  }
}
