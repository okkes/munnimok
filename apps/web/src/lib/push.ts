import { apiFetch } from './api';
import { getCurrentLang } from '@/i18n';
import { getNativePushToken, isNativeApp, nativePushPermitted, unregisterNativePush } from './platform';

/**
 * Push subscription management. Only user identities subscribe —
 * demo/offline have no server to push from. Web/PWA: Web Push, rendered
 * by the service worker (src/sw.ts). Native shell: FCM/APNs device
 * tokens through the platform adapter — the server fans out per kind.
 */

/** the native shell remembers its device token so disable can unregister */
const FCM_TOKEN_KEY = 'munni_fcm_token';

// truthiness, not `in`: WebKit exposes the serviceWorker interface with
// an undefined getter inside the capacitor:// webview (GlitchTip iOS
// crash: "undefined is not an object (evaluating 'navigator.serviceWorker.ready')")
export const pushSupported = (): boolean =>
  isNativeApp() || (!!navigator.serviceWorker && 'PushManager' in window && 'Notification' in window);

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(raw, (c) => c.codePointAt(0)!);
}

export async function getPushSubscription(): Promise<PushSubscription | null> {
  // native has FCM/APNs tokens, never a web push subscription
  if (isNativeApp() || !navigator.serviceWorker || !pushSupported()) return null;
  const registration = await navigator.serviceWorker.ready;
  return registration.pushManager.getSubscription();
}

/**
 * The settings toggle's source of truth. The native shell registers an
 * FCM token (kept in localStorage), NOT a web push subscription — the
 * old subscription check read OFF after every app kill on Android even
 * though pushes kept arriving (user report).
 */
export async function pushEnabled(): Promise<boolean> {
  if (isNativeApp()) return !!localStorage.getItem(FCM_TOKEN_KEY);
  return !!(await getPushSubscription());
}

// lang: the server writes the phone's visible text itself — a closed iPhone shows nothing for a data-only push
const fileWithServer = (registration: Record<string, unknown>): Promise<boolean> =>
  apiFetch('/me/push-subscriptions', {
    method: 'POST',
    body: JSON.stringify({ ...registration, lang: getCurrentLang() }),
  })
    .then((response) => response.ok)
    .catch(() => false);

async function fileNativeToken(token: string): Promise<boolean> {
  if (!(await fileWithServer({ kind: 'fcm', endpoint: token }))) return false;
  localStorage.setItem(FCM_TOKEN_KEY, token);
  return true;
}

function fileSubscription(subscription: PushSubscription): Promise<boolean> {
  const keys = subscription.toJSON().keys;
  return fileWithServer({ endpoint: subscription.endpoint, p256dh: keys?.p256dh, auth: keys?.auth });
}

/** a refusal is the person's (or the phone's) answer, a failure is ours — the switch words them apart */
export type PushEnableOutcome = 'registered' | 'no-permission' | 'failed';

/** asks permission, subscribes the browser and registers with the API */
export async function enablePush(vapidPublicKey: string): Promise<PushEnableOutcome> {
  if (isNativeApp()) {
    if (!(await nativePushPermitted())) return 'no-permission';
    const token = await getNativePushToken();
    if (!token) return 'failed';
    return (await fileNativeToken(token)) ? 'registered' : 'failed';
  }
  if (!pushSupported() || !navigator.serviceWorker) return 'failed';
  if ((await Notification.requestPermission()) !== 'granted') return 'no-permission';
  try {
    const registration = await navigator.serviceWorker.ready;
    const subscription =
      (await registration.pushManager.getSubscription()) ??
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) as BufferSource,
      }));
    return (await fileSubscription(subscription)) ? 'registered' : 'failed';
  } catch {
    // the browser's push service refused, or is out of reach
    return 'failed';
  }
}

/**
 * The server can lose a device, or still file it under the account that
 * used it before: its registration goes out again, never with a prompt.
 */
export async function refreshPushRegistration(): Promise<boolean> {
  if (isNativeApp()) {
    if (!localStorage.getItem(FCM_TOKEN_KEY)) return false;
    // the plugin's token of this launch — the remembered one may have been rotated away
    const token = await getNativePushToken();
    return token ? fileNativeToken(token) : false;
  }
  const subscription = await getPushSubscription().catch(() => null);
  return subscription ? fileSubscription(subscription) : false;
}

const refreshedSessions = new WeakSet<object>();

/** one refresh per signed-in session (`session`: anything that lives as long as it does) */
export async function refreshPushRegistrationOnce(session: object): Promise<void> {
  if (refreshedSessions.has(session)) return;
  refreshedSessions.add(session);
  // an attempt that did not land leaves the session open for the next occasion
  if (!(await refreshPushRegistration())) refreshedSessions.delete(session);
}

/** the Settings row's test: the API pushes to every registered device of this user — how many, or null when it
 *  failed. Sent from a space's settings, the notification names that space and its tap returns there (#551). */
export async function sendTestPush(spaceId?: string): Promise<number | null> {
  const query = spaceId ? `?spaceId=${encodeURIComponent(spaceId)}` : '';
  const response = await apiFetch(`/me/push-subscriptions/test${query}`, { method: 'POST' }).catch(() => null);
  if (!response?.ok) return null;
  const body = (await response.json().catch(() => ({}))) as { sent?: number };
  return body.sent ?? 0;
}

const forgetOnServer = (endpoint: string): Promise<unknown> =>
  apiFetch(`/me/push-subscriptions?endpoint=${encodeURIComponent(endpoint)}`, { method: 'DELETE' }).catch(() => undefined);

/**
 * The device lets go by itself, at once and beside the server call: once the
 * account has left it, nobody can tell a server that was out of reach.
 * `server: false` — it refuses this device already, or erased the account.
 */
export async function disablePush({ server = true }: { server?: boolean } = {}): Promise<void> {
  if (isNativeApp()) {
    const token = localStorage.getItem(FCM_TOKEN_KEY);
    if (!token) return;
    localStorage.removeItem(FCM_TOKEN_KEY);
    await Promise.all([server ? forgetOnServer(token) : undefined, unregisterNativePush()]);
    return;
  }
  const subscription = await getPushSubscription().catch(() => null);
  if (!subscription) return;
  await Promise.all([
    server ? forgetOnServer(subscription.endpoint) : undefined,
    subscription.unsubscribe().catch(() => false),
  ]);
}

