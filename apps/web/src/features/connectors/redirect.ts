import { publicOrigin } from '@/app/config';
import { nativePlatform } from '@/lib/platform';
import { callbackSchemeOf, ownReturn } from './manifestForm';

/**
 * A `redirect` challenge: the party's page opens where a first-party
 * sign-in would (docs/native-auth-popupless.md) — iOS runs it in the auth
 * session with the PARTY's callback scheme, so the address the login ends
 * on comes straight back; Android opens a Custom Tab and the web a new
 * tab, and both fall back to the human pasting that address.
 *
 * A party that comes back to the app's own return page (§15: an
 * open-banking consent lands on `/gc-callback`) is different: on a phone
 * the system browser opens it and the App Link re-enters the app on the
 * return page; on the web this very tab goes to the bank and comes back
 * to the return page. Nothing to paste, nothing to capture.
 */
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string | null; cancelled?: boolean }>;
}
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}
const plugins = (): { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } } }).Capacitor?.Plugins;

/** opens the page; resolves with the captured return address, or null when the human has to paste it — or when the return page takes over */
export async function openPartyPage(url: string, returnPattern: string | undefined): Promise<string | null> {
  const p = plugins();
  if (ownReturn(returnPattern, publicOrigin())) {
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
