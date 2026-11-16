import { create } from 'zustand';
import { registerSW } from 'virtual:pwa-register';
import { router } from '@/app/router';
import { isNativeApp, onNativePushTap } from '@/lib/platform';
import { buildNotification } from '@/sync/swNotifications';
import type { PushPayload } from '@/sync/swNotifications';

interface PwaState {
  needRefresh: boolean;
  update: () => void;
  dismiss: () => void;
}

export const usePwa = create<PwaState>((set) => ({
  needRefresh: false,
  update: () => undefined,
  dismiss: () => set({ needRefresh: false }),
}));

export function initPwa(): void {
  initViewportHeightVar();
  // #551: notification taps route on every surface, the native shell included
  initNotificationNav();
  // the native shell bundles the web assets: a service worker is pointless and its update toast a lie
  // (the real update is a store update, prompted by useNativeUpdateCheck)
  if (isNativeApp()) return;
  const updateSW = registerSW({
    onNeedRefresh() {
      usePwa.setState({ needRefresh: true, update: () => void updateSW(true) });
    },
  });
}

// whitelist: a worker message or push payload must not steer the router anywhere else
const NOTIFICATION_TARGETS =
  /^\/(?:review|transactions|friends|spaces|planning|recurring|debts|insights|settings|budgets\/(?!new$)[A-Za-z0-9_-]+|spaces\/[A-Za-z0-9_-]+\/members)$/;
const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

// notification url → in-app href, null off the whitelist; #551: `?space=` comes from the message (warm) or the url (cold)
export function notificationHref(url: string, spaceId?: string): string | null {
  const [path, query = ''] = (url.split('#')[1] ?? '').split('?');
  if (!path || !NOTIFICATION_TARGETS.test(path)) return null;
  const space = spaceId ?? new URLSearchParams(query).get('space') ?? undefined;
  return space && ID_SHAPE.test(space) ? `${path}?space=${space}` : path;
}

/** window event re-broadcast on a worker push while the app is open; server-backed lists refresh on it */
export const PUSH_EVENT = 'munni-push';

/** worker → app messages: NAVIGATE deep-links a click while the app is open (a worker can only focus a client) */
export function handleWorkerMessage(data: unknown): void {
  const message = data as { type?: string; url?: string; spaceId?: string } | undefined;
  if (message?.type === 'PUSH') {
    window.dispatchEvent(new Event(PUSH_EVENT));
    return;
  }
  if (message?.type !== 'NAVIGATE' || typeof message.url !== 'string') return;
  const href = notificationHref(message.url, message.spaceId);
  if (href) void router.navigate({ href });
}

function initNotificationNav(): void {
  navigator.serviceWorker?.addEventListener('message', (event) => handleWorkerMessage(event.data));
  // §5: native shell taps ride the same bridge: the FCM data payload maps to a url like the sw's clicks
  onNativePushTap((payload) => {
    const lang = localStorage.getItem('munni_lang') ?? 'en';
    const target = buildNotification(payload as PushPayload, lang);
    if (target?.url) handleWorkerMessage({ type: 'NAVIGATE', url: target.url, spaceId: target.pullSpaceId });
  });
}

// iOS: 100dvh/100vh left a dead band under the tab bar; innerHeight is what WebKit renders and, unlike visualViewport,
// ignores the keyboard (--vvh). A standalone PWA settles its viewport after launch with no resize event: timed re-measures
function initViewportHeightVar(): void {
  const apply = () => {
    // measured on-device (iPhone standalone): innerHeight = dvh = svh < screen.height; a screen.height fallback
    // overshoots and clips the tab bar
    const height = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    document.documentElement.style.setProperty('--vvh', `${height}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.visualViewport?.addEventListener('resize', apply);
  window.addEventListener('pageshow', apply); // bfcache restores skip load
  document.addEventListener('visibilitychange', apply); // standalone app-switch return
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
  for (const delay of [150, 500, 1000, 2500]) setTimeout(apply, delay);
}

// Android's one-shot Background Sync flushes the outbox once connectivity returns even if the app is killed; iOS: next open
export function requestOutboxSync(): void {
  void navigator.serviceWorker?.ready
    .then((registration) => {
      const syncable = registration as ServiceWorkerRegistration & {
        sync?: { register: (tag: string) => Promise<void> };
      };
      return syncable.sync?.register('munni-outbox');
    })
    .catch(() => undefined); // unsupported/denied — normal on iOS
}
