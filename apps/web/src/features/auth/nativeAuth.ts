import LogtoClient from '@logto/browser';
import type { LogtoConfig } from '@logto/browser';
import { config } from '@/app/config';
import { NATIVE_CALLBACK_KEY, nativePlatform } from '@/lib/platform';

/**
 * The redirect policy of record (docs/native-auth-popupless.md, RFC 8252):
 * first-party sign-in on the phone runs in the platform's auth session —
 * never in the webview, never in a plain browser tab that has to bounce
 * back through a custom-scheme link and its "Open in munni?" question.
 *  - iOS: ASWebAuthenticationSession (the AuthSession plugin registered in
 *    AppDelegate.swift) hands the callback URL straight back to JS.
 *  - Android: a Custom Tab (@capacitor/browser); Logto redirects to the
 *    app's scheme, the singleTask activity receives it and the tab folds.
 * The callback is the scheme form (munni-<env>-<platform>://…) — the
 * redirect URIs Logto registered for the native app.
 */
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string | null; cancelled?: boolean }>;
}
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}
const plugins = (): { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } } }).Capacitor?.Plugins;

export const nativeCallbackUri = (): string => `${config.nativeScheme}://auth-callback`;
export const nativeSignedOutUri = (): string => `${config.nativeScheme}://signed-out`;

/** where the app lands once the callback URL is back: the exchange screen, or the login screen after a sign-out */
export const landingFor = (callbackUrl: string): string => (callbackUrl.includes('signed-out') ? '/#/login' : '/auth-callback');

/**
 * Every navigation the Logto client asks for on the phone (sign-in, the
 * end-session round-trip) goes through here. `go` is the final in-app
 * navigation — injectable so the seam is testable without a window.
 */
export async function nativeNavigate(url: string, go: (path: string) => void = (path) => globalThis.location.assign(path)): Promise<void> {
  const p = plugins();
  if (nativePlatform() === 'ios' && p?.AuthSession?.start) {
    const result = await p.AuthSession.start({ url, callbackScheme: config.nativeScheme });
    if (!result.url) return; // cancelled by the user — the app stays where it was
    sessionStorage.setItem(NATIVE_CALLBACK_KEY, result.url);
    go(landingFor(result.url));
    return;
  }
  if (p?.Browser?.open) {
    // the Custom Tab: the scheme redirect at its end reaches the app through appUrlOpen (initDeepLinks)
    await p.Browser.open({ url });
    return;
  }
  go(url);
}

/** the Logto client the native shell uses: its navigations run in the auth session */
export class NativeLogtoClient extends LogtoClient {
  constructor(logtoConfig: LogtoConfig, unstableEnableCache = false) {
    super(logtoConfig, unstableEnableCache);
    // the adapter's navigate takes (url, options) — the options (redirect intent) do not matter to an auth session
    (this.adapter as unknown as { navigate: (target: string, ...rest: unknown[]) => void | Promise<void> }).navigate = (target: string) => {
      void nativeNavigate(target);
    };
  }
}
