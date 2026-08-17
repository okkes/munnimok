/**
 * #222: a dead refresh grant (Logto answers `invalid_grant` to the
 * refresh POST) is an IDENTITY state, not connectivity — every API
 * call 401s while the network is fine, and only a fresh sign-in can
 * cure it. The SDK swallows the failure into `undefined`, which used
 * to read as "no bearer sent — proves nothing" downstream, so the app
 * showed "server not available" forever. This flag names the state:
 * the UI says "sign in again", and the token bridge stops hammering
 * the dead grant.
 */
let expired = false;
const listeners = new Set<() => void>();

const notify = (): void => {
  for (const listener of listeners) listener();
};

/** returns true only on the marking transition — callers report once */
export function markSessionExpired(): boolean {
  if (expired) return false;
  expired = true;
  notify();
  return true;
}

export function clearSessionExpired(): void {
  if (!expired) return;
  expired = false;
  notify();
}

export const isSessionExpired = (): boolean => expired;

export function subscribeSessionExpiry(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Logto's verdict on a spent refresh grant, in either error shape */
export function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rawCode = (err as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  const message = err instanceof Error ? err.message : '';
  return code.includes('invalid_grant') || message.includes('Grant request is invalid');
}

const PAGE_LOADED_AT = Date.now();
const REENTRY_KEY = 'munni_grant_reheal';

/**
 * One silent redirect per tab visit, and only near app open ("sometimes
 * when I open the app" — the reported shape): the IdP session cookie
 * usually outlives the grant, so the round-trip re-mints tokens without
 * the user typing anything. Mid-use we show the banner instead — a
 * surprise redirect would eat unsaved sheet state.
 */
export async function attemptSilentReentry(signIn: () => Promise<void>): Promise<boolean> {
  if (!navigator.onLine) return false;
  if (Date.now() - PAGE_LOADED_AT > 30_000) return false;
  if (sessionStorage.getItem(REENTRY_KEY)) return false;
  sessionStorage.setItem(REENTRY_KEY, '1');
  await signIn();
  return true;
}

/** a token minted again — the next expiry gets its own silent attempt */
export function clearReentryMark(): void {
  sessionStorage.removeItem(REENTRY_KEY);
}

/** test seam — module state must not leak between specs */
export function resetSessionExpiryForTests(): void {
  expired = false;
  listeners.clear();
}
