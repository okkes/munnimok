import { create } from 'zustand';
import { registerSW } from 'virtual:pwa-register';
import { router } from '@/app/router';

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
  const updateSW = registerSW({
    onNeedRefresh() {
      usePwa.setState({ needRefresh: true, update: () => void updateSW(true) });
    },
  });
  initViewportHeightVar();
  initNotificationNav();
}

// only routes a notification may ever target — a whitelist keeps the
// worker message from steering the router anywhere else
const NOTIFICATION_TARGETS = ['/transactions', '/friends', '/spaces'] as const;

/**
 * Deep-link notification clicks while the app is already open: the
 * worker can only focus an existing client, not re-point its URL, so it
 * posts the target route and this listener navigates. Exported for tests.
 */
export function handleWorkerMessage(data: unknown): void {
  const message = data as { type?: string; url?: string } | undefined;
  if (message?.type !== 'NAVIGATE' || typeof message.url !== 'string') return;
  const path = message.url.split('#')[1]; // './#/friends' → '/friends'
  const target = NOTIFICATION_TARGETS.find((route) => route === path);
  if (target) void router.navigate({ to: target });
}

function initNotificationNav(): void {
  navigator.serviceWorker?.addEventListener('message', (event) => handleWorkerMessage(event.data));
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
    let height = Math.max(window.innerHeight, document.documentElement.clientHeight || 0);
    // iPhone standalone: with black-translucent + viewport-fit=cover the
    // installed app covers the entire screen, so in portrait screen.height
    // IS the truth — innerHeight sometimes never settles after launch (it
    // keeps the launch-screen size and fires no resize), leaving a dead
    // band under the tab bar. Guarded to iPhone: iPad PWAs can run in
    // resizable windows where screen.height overshoots.
    if (
      /iPhone/.test(navigator.userAgent) &&
      window.matchMedia('(display-mode: standalone)').matches &&
      window.matchMedia('(orientation: portrait)').matches
    ) {
      height = Math.max(height, window.screen.height);
    }
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
