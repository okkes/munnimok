/**
 * Platform adapter seam (native-apps design N2): the ONE place web code
 * asks "am I inside the Capacitor shell?". Detection rides the injected
 * `window.Capacitor` global — the web bundle never imports
 * @capacitor/core, so web/PWA builds carry zero native code.
 */

interface CapacitorPluginListener {
  addListener?: (event: string, cb: (data: never) => void) => unknown;
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  Plugins?: {
    App?: CapacitorPluginListener & object;
    PushNotifications?: CapacitorPluginListener & {
      requestPermissions?: () => Promise<{ receive: string }>;
      register?: () => Promise<void>;
    };
  };
}

const capacitor = (): CapacitorGlobal | undefined =>
  (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;

export const isNativeApp = (): boolean => capacitor()?.isNativePlatform?.() === true;

/**
 * Web/PWA: ask the browser not to evict IndexedDB. Native: a no-op —
 * WebView storage is app-scoped application data, never evicted.
 */
export async function ensurePersistentStorage(): Promise<void> {
  if (isNativeApp()) return;
  await navigator.storage?.persist?.().catch(() => undefined);
}

/** munni://gc-callback?ref=… → /gc-callback?ref=… (null for foreign urls) */
export function deepLinkToPath(url: string): string | null {
  const match = /^munni:\/\/([\w./-]*)(\?[^#]*)?/.exec(url);
  if (!match) return null;
  const path = match[1].replace(/^\/+/, '');
  return `/${path}${match[2] ?? ''}`;
}

/** the untouched munni:// callback url — the OIDC code exchange must
 *  present EXACTLY the redirect_uri that was registered, not the
 *  webview's localhost translation of it */
export const NATIVE_CALLBACK_KEY = 'munni_native_callback';

/**
 * Native deep links (N3): bank-consent and auth callbacks arrive as
 * munni:// urls while the app runs. Both callback screens live OUTSIDE
 * the hash router on real paths, so a full navigation is the correct
 * (and simplest) re-entry — the shell serves index.html for any path.
 */
export function initDeepLinks(): void {
  if (!isNativeApp()) return;
  const app = capacitor()?.Plugins?.App;
  app?.addListener?.('appUrlOpen', (data: { url?: string }) => {
    const url = data.url ?? '';
    const path = deepLinkToPath(url);
    if (!path) return;
    if (path.startsWith('/auth-callback')) sessionStorage.setItem(NATIVE_CALLBACK_KEY, url);
    globalThis.location.assign(path);
  });
}

/**
 * Native push registration (N4): resolves the FCM/APNs device token, or
 * null when not native / permission denied. Web push stays in lib/push.
 */
export async function getNativePushToken(): Promise<string | null> {
  const push = capacitor()?.Plugins?.PushNotifications;
  if (!isNativeApp() || !push?.register) return null;
  const permission = await push.requestPermissions?.();
  if (permission?.receive !== 'granted') return null;
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
