import { nativePlatform } from '@/lib/platform';
import { callbackSchemeOf } from './manifestForm';

/**
 * A `redirect` challenge: the party's page opens where a first-party
 * sign-in would (docs/native-auth-popupless.md) — iOS runs it in the auth
 * session with the PARTY's callback scheme, so the address the login ends
 * on comes straight back; Android opens a Custom Tab and the web a new
 * tab, and both fall back to the human pasting that address.
 */
interface AuthSessionPlugin {
  start(options: { url: string; callbackScheme: string }): Promise<{ url: string | null; cancelled?: boolean }>;
}
interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
}
const plugins = (): { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } | undefined =>
  (globalThis as { Capacitor?: { Plugins?: { AuthSession?: AuthSessionPlugin; Browser?: BrowserPlugin } } }).Capacitor?.Plugins;

/** opens the page; resolves with the captured return address, or null when the human has to paste it */
export async function openPartyPage(url: string, returnPattern: string | undefined): Promise<string | null> {
  const p = plugins();
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
