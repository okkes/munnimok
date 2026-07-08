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
