/** the ONE place web code asks "inside the Capacitor shell?": detection rides the injected `window.Capacitor`,
 *  the web bundle never imports @capacitor/core */

import { publicOrigin } from '@/app/config';

interface CapacitorPluginListener {
  addListener?: (event: string, cb: (data: never) => void) => unknown;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: {
    App?: CapacitorPluginListener & {
      getInfo?: () => Promise<{ id?: string; build?: string; version?: string }>;
    };
    /** the platform auth session (AppDelegate.swift): a sheet the app can end itself */
    AuthSession?: {
      cancel?: () => Promise<void>;
    };
    /** the in-app browser (Capacitor Browser): closes on iOS, a no-op on Android */
    Browser?: {
      open?: (options: { url: string }) => Promise<void>;
      close?: () => Promise<void>;
    };
    /** the Android shell's own plugin (ExitReasonsPlugin.java): how the app's processes ended lately */
    ExitReasons?: {
      recent?: () => Promise<NativeExits>;
    };
    PushNotifications?: CapacitorPluginListener & {
      requestPermissions?: () => Promise<{ receive: string }>;
      register?: () => Promise<void>;
      unregister?: () => Promise<void>;
      removeAllDeliveredNotifications?: () => Promise<void>;
      getDeliveredNotifications?: () => Promise<{ notifications?: NativeDelivered[] }>;
      removeDeliveredNotifications?: (delivered: { notifications: NativeDelivered[] }) => Promise<void>;
    };
    StatusBar?: {
      setStyle?: (options: { style: 'LIGHT' | 'DARK' }) => Promise<void>;
    };
    Camera?: {
      getPhoto?: (options: {
        resultType: string;
        source: string;
        quality: number;
        correctOrientation?: boolean;
      }) => Promise<{ base64String?: string; format?: string }>;
    };
    NativeBiometric?: {
      isAvailable?: () => Promise<{ isAvailable?: boolean }>;
      verifyIdentity?: (options: { reason?: string; title?: string }) => Promise<void>;
    };
    Haptics?: {
      notification?: (options: { type: 'SUCCESS' | 'WARNING' | 'ERROR' }) => Promise<void>;
    };
    Share?: {
      share?: (options: { title?: string; files?: string[] }) => Promise<unknown>;
    };
    Filesystem?: {
      writeFile?: (options: {
        path: string;
        data: string;
        directory: string;
        encoding?: string;
      }) => Promise<{ uri: string }>;
    };
  };
}

const capacitor = (): CapacitorGlobal | undefined =>
  (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;

export const isNativeApp = (): boolean => capacitor()?.isNativePlatform?.() === true;

/** iOS WebKit on ANY surface (tab, PWA, shell); mirrors react-modal-sheet's platform test (#134) so opt-outs fire with it */
export const isIOS = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  const platform =
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /^iP(hone|ad|od)/i.test(platform) || (/^Mac/i.test(platform) && navigator.maxTouchPoints > 1);
};

/** a phone's or tablet's browser — not the shell, which has its own ways back in */
export const isMobileWeb = (): boolean =>
  !isNativeApp() && (isIOS() || /Android/i.test(globalThis.navigator?.userAgent ?? ''));

/** leaves this document for the app's own scheme; where no app answers it, nothing happens and the page stays */
export function openApp(url: string): void {
  try {
    globalThis.location.replace(url);
  } catch {
    // a browser that refuses the scheme outright: the button on the page remains
  }
}

// web: ask the browser not to evict IndexedDB; native: no-op, WebView storage is never evicted
export async function ensurePersistentStorage(): Promise<void> {
  if (isNativeApp()) return;
  await navigator.storage?.persist?.().catch(() => undefined);
}

// accepts munni-<env>-<platform>:// too: a dash-blind pattern drops the sign-in's own return and the bank's
/** the https paths a verified App Link / universal link may hand us —
 *  a tight allowlist so nothing else ever routes into the shell */
const UNIVERSAL_LINK_PATHS = ['/gc-callback', '/splits/join/', '/invite'];

export function deepLinkToPath(url: string): string | null {
  const match = /^munni(?:-[\w-]+)?:\/\/([\w./-]*)(\?[^#]*)?/.exec(url);
  if (match) {
    const path = match[1].replace(/^\/+/, '');
    return `/${path}${match[2] ?? ''}`;
  }
  // universal links (UL2): hosts derive from publicOrigin, not a literal (the domain is a secret in this public repo);
  // channel siblings (munni./munni-test. on the same parent) stay accepted
  if (url.startsWith('https://')) {
    try {
      const parsed = new URL(url);
      const own = new URL(publicOrigin()).hostname;
      const parent = own.split('.').slice(1).join('.');
      const hostOk = parsed.hostname === own || (!!parent && parsed.hostname.endsWith(`.${parent}`));
      if (hostOk && UNIVERSAL_LINK_PATHS.some((prefix) => parsed.pathname.startsWith(prefix))) {
        return parsed.pathname + parsed.search;
      }
    } catch {
      return null;
    }
  }
  return null;
}

/** the untouched munni:// callback url: the OIDC code exchange must present EXACTLY the registered redirect_uri */
export const NATIVE_CALLBACK_KEY = 'munni_native_callback';

// ends the auth session / in-app browser the shell opened: a bank's app hands its https return to Safari, so the sheet sits
// on a page that can never finish (Enable Banking "returning to the authentication initiator"). Best effort: an older
// shell without the method, or Android's Custom Tab (no close), keeps what it shows
export function closeInAppBrowser(): void {
  const plugins = capacitor()?.Plugins;
  void plugins?.AuthSession?.cancel?.()?.catch(() => undefined);
  void plugins?.Browser?.close?.()?.catch(() => undefined);
}

// both callback screens live OUTSIDE the hash router on real paths: a full navigation is the re-entry
export function initDeepLinks(): void {
  if (!isNativeApp()) return;
  const app = capacitor()?.Plugins?.App;
  app?.addListener?.('appUrlOpen', (data: { url?: string }) => {
    const url = data.url ?? '';
    const path = deepLinkToPath(url);
    if (!path) return;
    if (path.startsWith('/auth-callback')) sessionStorage.setItem(NATIVE_CALLBACK_KEY, url);
    // post sign-out landing: the session is already cleared locally
    if (path.startsWith('/signed-out')) {
      globalThis.location.assign('/#/login');
      return;
    }
    if (path.startsWith('/gc-callback')) closeInAppBrowser();
    // callbacks live on real paths; everything else (app shortcuts like munni://review) is a hash route
    const realPath = path.startsWith('/auth-callback') || path.startsWith('/gc-callback');
    globalThis.location.assign(realPath ? path : `/#${path}`);
  });
}

// the plugin's Style.Light means light BACKGROUND (dark icons), inverted from our theme name;
// without this Android keeps white icons on the cream background
export function syncNativeStatusBar(theme: 'light' | 'dark'): void {
  if (!isNativeApp()) return;
  void capacitor()?.Plugins?.StatusBar?.setStyle?.({ style: theme === 'dark' ? 'DARK' : 'LIGHT' })?.catch(() => undefined);
}

export const nativePlatform = (): string | undefined =>
  isNativeApp() ? capacitor()?.getPlatform?.() : undefined;

export interface NativeExitRecord {
  at: number;
  /** ApplicationExitInfo's reason code */
  reason: number;
  description?: string | null;
  /** how important the system held the process when it ended: 100 is "on screen" */
  importance?: number;
  status?: number;
  pssKb?: number;
  rssKb?: number;
  process?: string | null;
}

export interface NativeExits {
  exits?: NativeExitRecord[];
  /** "time\nthread\nstack trace" of an exception nothing caught, noted by the shell as the app went down */
  javaCrash?: string | null;
  /** "time\ncrashed|killed\npriority" of the web view's own process */
  renderer?: string | null;
}

/** what the Android shell knows about how the app ended lately; null on any other surface, or on a shell from before it could say */
export async function nativeExits(): Promise<NativeExits | null> {
  const plugin = capacitor()?.Plugins?.ExitReasons;
  if (nativePlatform() !== 'android' || !plugin?.recent) return null;
  return plugin.recent().catch(() => null);
}

// the store numbers a binary by the clock: only the bundle's own commit count compares with the hosted version.json
export const bundledWebBuild = (): number => Number(__BUILD_NUMBER__);

// every environment is its own app in the stores, so the id comes from the shell — never from the channel
export async function getNativeAppId(): Promise<string | null> {
  const app = capacitor()?.Plugins?.App;
  if (!isNativeApp() || !app?.getInfo) return null;
  try {
    return (await app.getInfo()).id ?? null;
  } catch {
    return null;
  }
}

// the webview's <input capture> crashes on iOS and is gallery-only on Android, so the shells use the Camera plugin;
// 'PHOTOS' = the library (#496); pictures come back JPEG, so a possibly see-through one never takes 'PHOTOS' (#522)
export async function takeNativePhoto(source: 'CAMERA' | 'PHOTOS' = 'CAMERA'): Promise<File | null> {
  const camera = capacitor()?.Plugins?.Camera;
  if (!isNativeApp() || !camera?.getPhoto) return null;
  try {
    const photo = await camera.getPhoto({
      resultType: 'base64',
      source,
      quality: 80,
      correctOrientation: true,
    });
    if (!photo.base64String) return null;
    const bytes = Uint8Array.from(atob(photo.base64String), (c) => c.codePointAt(0) ?? 0);
    const format = photo.format ?? 'jpeg';
    return new File([bytes], `receipt.${format}`, { type: `image/${format}` });
  } catch {
    return null; // user cancelled or permission denied — the button stays usable
  }
}

/** the phone's own yes to notifications — the OS asks once, afterwards only its settings change the answer */
export async function nativePushPermitted(): Promise<boolean> {
  const push = capacitor()?.Plugins?.PushNotifications;
  if (!isNativeApp() || !push?.requestPermissions) return false;
  const permission = await push.requestPermissions().catch(() => undefined);
  return permission?.receive === 'granted';
}

export async function getNativePushToken(): Promise<string | null> {
  const push = capacitor()?.Plugins?.PushNotifications;
  if (!isNativeApp() || !push?.register) return null;
  if (!(await nativePushPermitted())) return null;
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 10_000); // registration never answered
    push.addListener?.('registration', (token: { value?: string }) => {
      clearTimeout(timer);
      resolve(token.value ?? null);
    });
    push.addListener?.('registrationError', () => {
      clearTimeout(timer);
      resolve(null);
    });
    void push.register?.();
  });
}

// WKWebView has no WebAuthn platform authenticator: the shell uses the native prompt,
// web/PWA keeps WebAuthn (same lock.ts seam)
export async function nativeBiometricAvailable(): Promise<boolean> {
  const biometric = capacitor()?.Plugins?.NativeBiometric;
  if (!isNativeApp() || !biometric?.isAvailable) return false;
  try {
    return (await biometric.isAvailable()).isAvailable === true;
  } catch {
    return false;
  }
}

export async function nativeBiometricVerify(reason: string): Promise<boolean> {
  const biometric = capacitor()?.Plugins?.NativeBiometric;
  if (!biometric?.verifyIdentity) return false;
  try {
    await biometric.verifyIdentity({ reason, title: 'munni' });
    return true;
  } catch {
    return false;
  }
}

export function hapticNotify(type: 'SUCCESS' | 'WARNING' = 'SUCCESS'): void {
  if (!isNativeApp()) return;
  void capacitor()?.Plugins?.Haptics?.notification?.({ type })?.catch(() => undefined);
}

/** `unavailable`: not a shell — only then does a caller download in the browser */
export type NativeShare = 'shared' | 'dismissed' | 'failed' | 'unavailable';

export async function shareNativeFile(fileName: string, content: string): Promise<NativeShare> {
  const plugins = capacitor()?.Plugins;
  if (!isNativeApp() || !plugins?.Filesystem?.writeFile || !plugins.Share?.share) return 'unavailable';
  let uri: string;
  try {
    const written = await plugins.Filesystem.writeFile({
      path: fileName,
      data: content,
      directory: 'CACHE',
      encoding: 'utf8',
    });
    uri = written.uri;
  } catch {
    return 'failed';
  }
  try {
    await plugins.Share.share({ title: fileName, files: [uri] });
    return 'shared';
  } catch {
    // the plugin rejects a closed sheet: the file went nowhere, and a download does nothing in a webview
    return 'dismissed';
  }
}

/** #506: the shells open it in the in-app browser (a `_blank` window renders blank in the webview), the web in a new tab */
export function openExternal(url: string): void {
  const browser = capacitor()?.Plugins?.Browser;
  if (isNativeApp() && browser?.open) {
    void browser.open({ url }).catch(() => undefined);
    return;
  }
  globalThis.open(url, '_blank', 'noopener');
}

export const webSearchUrl = (query: string): string => `https://www.google.com/search?q=${encodeURIComponent(query.trim())}`;

// the payload rides FCM's data field as a JSON string;
// pwa.ts routes it through the same NAVIGATE bridge as the service worker
export function onNativePushTap(callback: (payload: unknown) => void): void {
  if (!isNativeApp()) return;
  capacitor()?.Plugins?.PushNotifications?.addListener?.(
    'pushNotificationActionPerformed',
    (action: { notification?: { data?: { payload?: string } } }) => {
      const raw = action.notification?.data?.payload;
      if (!raw) return;
      try {
        callback(JSON.parse(raw));
      } catch {
        // malformed payload — ignore
      }
    },
  );
}

/** the phone lets go of its push token by itself: an account can leave the device while the server is out of reach */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativeApp()) return;
  await capacitor()?.Plugins?.PushNotifications?.unregister?.().catch(() => undefined);
}

/** one notification in the phone's notification centre: Android names it by id + tag, iOS by id, and only iOS hands back the push's data */
export interface NativeDelivered {
  id: string | number;
  tag?: string | null;
  data?: Record<string, unknown>;
}

/** #614: what the phone still shows of munni; null outside the shell (or an older one) */
export async function nativeDelivered(): Promise<NativeDelivered[] | null> {
  const push = capacitor()?.Plugins?.PushNotifications;
  if (!isNativeApp() || !push?.getDeliveredNotifications || !push.removeDeliveredNotifications) return null;
  const answer = await push.getDeliveredNotifications().catch(() => undefined);
  return answer?.notifications ?? [];
}

export async function removeNativeDelivered(notifications: NativeDelivered[]): Promise<void> {
  await capacitor()
    ?.Plugins?.PushNotifications?.removeDeliveredNotifications?.({ notifications })
    .catch(() => undefined);
}

/** #580: takes munni's notifications off the phone's notification centre; false outside the shell (or an older one) */
export async function clearNativeDeliveredNotifications(): Promise<boolean> {
  const push = capacitor()?.Plugins?.PushNotifications;
  if (!isNativeApp() || !push?.removeAllDeliveredNotifications) return false;
  await push.removeAllDeliveredNotifications().catch(() => undefined);
  return true;
}
