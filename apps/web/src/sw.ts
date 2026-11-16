/// <reference lib="webworker" />
/* eslint-env serviceworker */
// injectManifest worker: precaching plus Web Push; runtime glue only, the decisions live in sync/swNotifications (tested)
import { cleanupOutdatedCaches, precacheAndRoute } from 'workbox-precaching';
import { backgroundPull, flushOutbox } from '@/sync/swSync';
import { evaluateBudgetAlertsFromWorker } from '@/sync/swBudgets';
import { evaluatePlanAlertsFromWorker } from '@/sync/swPlanning';
import { buildNotification, readWorkerLang } from '@/sync/swNotifications';
import type { PushPayload } from '@/sync/swNotifications';

declare const self: ServiceWorkerGlobalScope;

cleanupOutdatedCaches();
// the MDI icon font's ?v= query defeats the precache lookup (icons rendered as squares offline); precached assets are
// content-hashed, so matching URLs without their query is always safe
precacheAndRoute(self.__WB_MANIFEST, { ignoreURLParametersMatching: [/.*/] });

// /runtime-config.js (rewritten per deployment by nginx, excluded from the precache) is served network-first so an offline
// relaunch boots with the last-seen config instead of the baked defaults
const RUNTIME_CONFIG_CACHE = 'munni-runtime-config';
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/runtime-config.js') return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(RUNTIME_CONFIG_CACHE);
      try {
        const fresh = await fetch(event.request);
        if (fresh.ok) await cache.put(event.request, fresh.clone());
        return fresh;
      } catch {
        const cached = await cache.match(event.request);
        // no cached copy either: an empty overlay keeps the baked config
        return cached ?? new Response('', { headers: { 'Content-Type': 'text/javascript' } });
      }
    })(),
  );
});

self.addEventListener('message', (event) => {
  // defense in depth: verify the origin explicitly rather than trust that only controlled pages post here
  if (event.origin && event.origin !== self.location.origin) return;
  if ((event.data as { type?: string } | undefined)?.type === 'SKIP_WAITING') void self.skipWaiting();
});

self.addEventListener('push', (event) => {
  const payload = (() => {
    try {
      return (event.data?.json() ?? {}) as PushPayload;
    } catch {
      return {} as PushPayload;
    }
  })();

  event.waitUntil(
    (async () => {
      // the notification first — iOS requires one per push event
      const lang = await readWorkerLang();
      const notification = buildNotification(payload, lang);
      if (!notification) return;
      await self.registration.showNotification(notification.title, {
        body: notification.body,
        icon: 'icon-192.png',
        badge: 'icon-192.png',
        tag: notification.tag,
        data: { url: notification.url, spaceId: notification.pullSpaceId },
      });
      const clientList = await self.clients.matchAll({ type: 'window' });
      for (const client of clientList) client.postMessage({ type: 'PUSH', payloadType: payload.type });

      if (!notification.pull) return;
      // …then pre-sync the announced data while awake so opening starts hot; best-effort, an expired mirrored token just skips
      try {
        await backgroundPull(notification.pullSpaceId);
        // budgets stay client-side (the server never learns them): this wake-up is the moment to warn about limits just crossed
        const alerts = [
          ...(await evaluateBudgetAlertsFromWorker(notification.pullSpaceId, lang)),
          ...(await evaluatePlanAlertsFromWorker(notification.pullSpaceId, lang)),
        ];
        for (const alert of alerts) {
          await self.registration.showNotification(alert.title, {
            body: alert.body,
            icon: 'icon-192.png',
            badge: 'icon-192.png',
            tag: alert.tag,
            data: { url: alert.url },
          });
        }
      } catch {
        // offline again / server hiccup — the app syncs on next open
      }
    })(),
  );
});

self.addEventListener('sync', (event: Event) => {
  const sync = event as Event & { tag?: string; waitUntil: (p: Promise<unknown>) => void };
  if (sync.tag !== 'munni-outbox') return;
  sync.waitUntil(
    (async () => {
      try {
        await flushOutbox();
        await backgroundPull();
      } catch {
        // the sync manager retries on rejection, but a missing/expired session must NOT loop: hence catch-all
      }
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data as { url?: string; spaceId?: string } | undefined;
  const url = data?.url ?? './#/transactions';
  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const existing = clientList[0];
      if (existing) {
        // a focused client keeps its current screen: post the target so the app's listener routes there
        existing.postMessage({ type: 'NAVIGATE', url, spaceId: data?.spaceId });
        await existing.focus();
      } else {
        // cold start: the space rides the url itself (hash query)
        await self.clients.openWindow(url);
      }
    })(),
  );
});
