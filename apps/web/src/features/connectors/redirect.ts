import { config, publicOrigin } from '@/app/config';
import { deepLinkToPath, nativePlatform } from '@/lib/platform';
import { callbackSchemeOf, ownReturn } from './manifestForm';

// a party's own scheme (docs/native-auth-popupless.md): iOS runs the auth session with the PARTY's scheme; else pasting
// a return to the app's own page (§15, /gc-callback): iOS runs the auth session with the APP's scheme, since a Safari
// view never came back (a redirect is not a tap, so the universal link did not open the app)
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string | null; cancelled?: boolean }>;
}
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}
const plugins = (): { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } } }).Capacitor?.Plugins;

export async function openPartyPage(url: string, returnPattern: string | undefined): Promise<string | null> {
  const p = plugins();
  if (ownReturn(returnPattern, publicOrigin())) {
    if (nativePlatform() === 'ios' && p?.AuthSession?.start) {
      const result = await p.AuthSession.start({ url, callbackScheme: config.nativeScheme });
      // the scheme form the return page bounced to, answered as the https landing the party named
      const path = result.url ? deepLinkToPath(result.url) : null;
      return path ? `${publicOrigin()}${path}` : null;
    }
    if (p?.Browser?.open) {
      await p.Browser.open({ url });
      return null;
    }
    globalThis.location.assign(url);
    return null;
  }
  const scheme = callbackSchemeOf(returnPattern);
  if (nativePlatform() === 'ios' && p?.AuthSession?.start && scheme) {
    const result = await p.AuthSession.start({ url, callbackScheme: scheme });
    return result.url ?? null;
  }
  if (p?.Browser?.open) {
    await p.Browser.open({ url });
    return null;
  }
  globalThis.open(url, '_blank', 'noopener');
  return null;
}
