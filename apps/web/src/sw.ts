/// <reference lib="webworker" />
/* eslint-env serviceworker */
// Custom service worker (vite-plugin-pwa injectManifest): precaching like
// the old generateSW build, plus Web Push — a notification wakes the
// device so new bank transactions are announced even while the app is
// closed, and opening the notification lands in a freshly syncing app.
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { backgroundPull, flushOutbox } from '@/sync/swSync';

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST);

// UpdateToast's reload button posts SKIP_WAITING (registerSW prompt mode)
self.addEventListener('message', (event) => {
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

// ── push notifications ──────────────────────────────────────────────────
// The app language is mirrored into a tiny IDB store (push workers boot
// cold, so module state would be lost).
const TEXTS: Record<string, { title: string; one: string; many: string }> = {
  en: { title: 'munni', one: '1 new transaction arrived', many: '{n} new transactions arrived' },
  nl: { title: 'munni', one: '1 nieuwe transactie ontvangen', many: '{n} nieuwe transacties ontvangen' },
  tr: { title: 'munni', one: '1 yeni işlem geldi', many: '{n} yeni işlem geldi' },
};

function readLang(): Promise<string> {
  return new Promise((resolve) => {
    const open = indexedDB.open('munni_sw', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onerror = () => resolve('en');
    open.onsuccess = () => {
      try {
        const get = open.result.transaction('kv', 'readonly').objectStore('kv').get('lang');
        get.onsuccess = () => resolve(typeof get.result === 'string' ? get.result : 'en');
        get.onerror = () => resolve('en');
      } catch {
        resolve('en');
      }
    };
  });
}

interface PushPayload {
  type?: string;
  spaceId?: string;
  count?: number;
}

self.addEventListener('push', (event) => {
  const payload = (() => {
    try {
      return (event.data?.json() ?? {}) as PushPayload;
    } catch {
      return {} as PushPayload;
    }
  })();
  if (payload.type !== 'new-transactions') return;

  event.waitUntil(
    (async () => {
      // the notification first — iOS requires one per push event
      const texts = TEXTS[await readLang()] ?? TEXTS.en;
      const count = payload.count ?? 1;
      const body = count === 1 ? texts.one : texts.many.replace('{n}', String(count));
      await self.registration.showNotification(texts.title, {
        body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: `new-tx-${payload.spaceId ?? 'all'}`, // coalesce per space
        data: { spaceId: payload.spaceId },
      });
      // …then pre-sync the announced data into IndexedDB while we're
      // awake, so opening the app (or the notification) starts hot.
      // Best-effort: an expired mirrored token just skips.
      try {
        await backgroundPull(payload.spaceId);
      } catch {
        // offline again / server hiccup — the app syncs on next open
      }
    })(),
  );
});

// Android one-shot Background Sync: connectivity returned while the app
// is killed — flush queued local ops, then pull what we missed.
self.addEventListener('sync', (event: Event) => {
  const sync = event as Event & { tag?: string; waitUntil: (p: Promise<unknown>) => void };
  if (sync.tag !== 'munni-outbox') return;
  sync.waitUntil(
    (async () => {
      try {
        await flushOutbox();
        await backgroundPull();
      } catch {
        // the sync manager retries with backoff on rejection — but a
        // missing/expired session must NOT loop, hence catch-all here
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientList[0];
      // focusing (or opening) the app triggers its start-up sync,
      // pulling the announced transactions immediately
      if (existing) await existing.focus();
      else await self.clients.openWindow('./#/transactions');
    })(),
  );
});
