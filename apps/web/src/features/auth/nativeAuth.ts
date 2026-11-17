import LogtoClient from '@logto/browser';
import type { LogtoConfig } from '@logto/browser';
import { config } from '@/app/config';
import { NATIVE_CALLBACK_KEY, nativePlatform } from '@/lib/platform';

// phone sign-in runs in the platform's auth session (RFC 8252, docs/native-auth-popupless.md), never webview or plain tab
// iOS: ASWebAuthenticationSession (AuthSession plugin) hands the callback URL straight back to JS
// Android: a Custom Tab; Logto redirects to the app's scheme and the singleTask activity receives it
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string | null; cancelled?: boolean }>;
}
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}
const plugins = (): { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } } }).Capacitor?.Plugins;

// the platform refuses a session while the window is mid-transition (GlitchTip 15, error 3 right after resume):
// retry once; only a second refusal is reported
export async function startAuthSession(
  session: AuthSessionPlugin,
  options: { url: string; callbackScheme: string },
  pause: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<{ url: string | null; cancelled?: boolean }> {
  try {
    return await session.start(options);
  } catch (err) {
    console.warn(`the auth session did not start (${err instanceof Error ? err.message : String(err)}) — trying once more`);
    await pause(400);
    return await session.start(options);
  }
}

export const nativeCallbackUri = (): string => `${config.nativeScheme}://auth-callback`;
export const nativeSignedOutUri = (): string => `${config.nativeScheme}://signed-out`;

export const landingFor = (callbackUrl: string): string => (callbackUrl.includes('signed-out') ? '/#/login' : '/auth-callback');

export async function nativeNavigate(url: string, go: (path: string) => void = (path) => globalThis.location.assign(path)): Promise<void> {
  const p = plugins();
  if (nativePlatform() === 'ios' && p?.AuthSession?.start) {
    const result = await startAuthSession(p.AuthSession, { url, callbackScheme: config.nativeScheme });
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

export class NativeLogtoClient extends LogtoClient {
  constructor(logtoConfig: LogtoConfig, unstableEnableCache = false) {
    super(logtoConfig, unstableEnableCache);
    // the adapter's navigate takes (url, options) — the options (redirect intent) do not matter to an auth session
    (this.adapter as unknown as { navigate: (target: string, ...rest: unknown[]) => void | Promise<void> }).navigate = (target: string) => {
      void nativeNavigate(target);
    };
  }
}
