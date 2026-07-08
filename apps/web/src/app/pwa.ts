import { create } from 'zustand';
import { registerSW } from 'virtual:pwa-register';

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
}

/**
 * iOS viewport height, measured instead of trusted: 100dvh (and 100vh)
 * proved unreliable on iPhones — both left a dead band under the tab
 * bar. window.innerHeight is what WebKit actually renders: it tracks
 * Safari's toolbar collapse/expansion, is exact in standalone PWAs, and
 * — unlike visualViewport.height — does NOT shrink when the keyboard
 * overlays the page. styles.css consumes the value as --vvh (iOS only).
 */
function initViewportHeightVar(): void {
  const apply = () =>
    document.documentElement.style.setProperty('--vvh', `${window.innerHeight}px`);
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('pageshow', apply); // bfcache restores skip load
  window.addEventListener('orientationchange', () => setTimeout(apply, 250));
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
