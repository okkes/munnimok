import { create } from 'zustand';
import { registerSW } from 'virtual:pwa-register';
import { router } from '@/app/router';
import { isNativeApp, onNativePushTap } from '@/lib/platform';
import { buildNotification } from '@/sync/swNotifications';
import type { PushPayload } from '@/sync/swNotifications';

interface PwaState {
  needRefresh: boolean;
  /** apply the waiting service worker and reload */
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
  // #551: notification taps route on every surface — the shell's taps never
  // did, this used to sit after the native return below
  initNotificationNav();
  // the native shell bundles the web assets in the binary — a service
  // worker there is pointless and its "new version" toast is a lie
  // (the real update is a store update). Native updates are prompted by
  // useNativeUpdateCheck instead.
  if (isNativeApp()) return;
  const updateSW = registerSW({
    onNeedRefresh() {
      usePwa.setState({ needRefresh: true, update: () => void updateSW(true) });
    },
  });
}

// only screens a notification may ever open — a whitelist keeps the
// worker message (or a push payload) from steering the router anywhere else
const NOTIFICATION_TARGETS =
  /^\/(?:review|transactions|friends|spaces|planning|recurring|debts|insights|settings|budgets\/(?!new$)[A-Za-z0-9_-]+|spaces\/[A-Za-z0-9_-]+\/members)$/;
/** id shapes riding worker messages are validated before the router sees them */
const ID_SHAPE = /^[A-Za-z0-9_-]+$/;

/**
 * A notification's url (`./#/planning?space=…`) → the in-app href it opens,
 * or null off the whitelist. #551: the space rides along as `?space=` —
 * from the message (the worker's warm path) or the url's own query (cold
 * starts) — and the app switches there (app/notificationSpace.tsx).
 */
export function notificationHref(url: string, spaceId?: string): string | null {
  const [path, query = ''] = (url.split('#')[1] ?? '').split('?');
  if (!path || !NOTIFICATION_TARGETS.test(path)) return null;
  const space = spaceId ?? new URLSearchParams(query).get('space') ?? undefined;
  return space && ID_SHAPE.test(space) ? `${path}?space=${space}` : path;
}

/** window event re-broadcast when the worker receives a push while the
 *  app is open — screens with server-backed lists refresh on it */
export const PUSH_EVENT = 'munni-push';

/**
 * Worker → app messages. NAVIGATE deep-links notification clicks while
 * the app is already open (the worker can only focus a client, not
 * re-point its URL); PUSH re-broadcasts an incoming push as a window
 * event. Exported for tests.
 */
export function handleWorkerMessage(data: unknown): void {
  const message = data as { type?: string; url?: string; spaceId?: string } | undefined;
  if (message?.type === 'PUSH') {
    window.dispatchEvent(new Event(PUSH_EVENT));
    return;
  }
  if (message?.type !== 'NAVIGATE' || typeof message.url !== 'string') return;
  // #132/#551: the tap lands on the announced screen IN the announced space
  const href = notificationHref(message.url, message.spaceId);
  if (href) void router.navigate({ href });
}

function initNotificationNav(): void {
  navigator.serviceWorker?.addEventListener('message', (event) => handleWorkerMessage(event.data));
  // §5: the native shell's notification taps ride the same bridge — the
  // FCM data payload maps to a target url exactly like the sw's clicks
  onNativePushTap((payload) => {
    const lang = localStorage.getItem('munni_lang') ?? 'en';
    const target = buildNotification(payload as PushPayload, lang);
    if (target?.url) handleWorkerMessage({ type: 'NAVIGATE', url: target.url, spaceId: target.pullSpaceId });
  });
}

/**
 * iOS viewport height, measured instead of trusted: 100dvh (and 100vh)
 * proved unreliable on iPhones — both left a dead band under the tab
 * bar. window.innerHeight is what WebKit actually renders: it tracks
 * Safari's toolbar collapse/expansion and — unlike
 * visualViewport.height — does NOT shrink when the keyboard overlays
 * the page. styles.css consumes the value as --vvh (iOS only).
 *
 * Installed (standalone) PWAs are the treacherous case: the viewport
 * settles AFTER launch without firing any resize event, so a single
 * boot-time measurement sticks at the launch-screen size and leaves a
 * dead band. Hence the extra signals and the timed boot re-measures.
 */
function initViewportHeightVar(): void {
  const apply = () => {
    // measured on-device (iPhone standalone, via the Settings diagnostics
    // overlay): inner = dvh = svh = visual < screen.height — the webview
    // does NOT cover the status bar band, so a screen.height fallback
    // overshoots and clips the tab bar. innerHeight is the truth.
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

/**
 * Ask the browser to flush the outbox when connectivity returns, even
 * if the app is killed meanwhile (Android's one-shot Background Sync;
 * iOS has no equivalent — there the outbox flushes on next open).
 */
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
