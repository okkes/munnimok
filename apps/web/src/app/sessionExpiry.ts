// #222: a dead refresh grant (Logto `invalid_grant`) is an identity state, not connectivity: every call 401s while the
// network is fine. The SDK swallows it into `undefined`, so this flag names it: UI says "sign in again", the token
// bridge stops hammering the grant
import { isNativeApp } from '@/lib/platform';

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

export function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rawCode = (err as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  const message = err instanceof Error ? err.message : '';
  return code.includes('invalid_grant') || message.includes('Grant request is invalid');
}

/** the SDK holds nothing to mint with (`not_authenticated`: no id token, or no refresh token once the access token ran out) */
export function isNoSessionError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'not_authenticated';
}

const PAGE_LOADED_AT = Date.now();
const REENTRY_KEY = 'munni_grant_reheal';
/** #272: cross-tab cooldown so a dead IdP session can't redirect-loop */
const REENTRY_AT_KEY = 'munni_grant_reheal_at';
const REENTRY_COOLDOWN_MS = 10 * 60_000;

// #272: expiry usually surfaces on returning to a long-idle tab, when nothing unsaved is at risk, so the redirect may fire
let lastBecameVisibleAt = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') lastBecameVisibleAt = Date.now();
  });
}

const inQuietWindow = (): boolean => {
  if (Date.now() - PAGE_LOADED_AT <= 30_000) return true; // near app open
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return true; // backgrounded
  return Date.now() - lastBecameVisibleAt <= 10_000; // just came back
};

// one silent redirect per expiry, only in quiet windows (#272); mid-use a redirect would eat unsaved sheet state.
// Never on the phone: the platform auth session pops an OS "wants to use <domain> to sign in" prompt by itself;
// the banner's Sign in button is the door there
export async function attemptSilentReentry(signIn: () => Promise<void>): Promise<boolean> {
  if (isNativeApp()) return false;
  if (!navigator.onLine) return false;
  if (!inQuietWindow()) return false;
  if (sessionStorage.getItem(REENTRY_KEY)) return false;
  const lastAt = Number(localStorage.getItem(REENTRY_AT_KEY) ?? 0);
  if (Date.now() - lastAt < REENTRY_COOLDOWN_MS) return false;
  sessionStorage.setItem(REENTRY_KEY, '1');
  localStorage.setItem(REENTRY_AT_KEY, String(Date.now()));
  await signIn();
  return true;
}

export function clearReentryMark(): void {
  sessionStorage.removeItem(REENTRY_KEY);
}

const REPROBE_EVERY_MS = 60_000;
let lastProbeAt = 0;

// the mark is sticky (a spent grant must not be hammered) but a passing refusal would keep it until a sign-in: when
// the device returns, the SDK is asked once a minute whether it still mints; a token lifts the mark, silence keeps it
export function watchForRevival(mint: () => Promise<string | undefined>): () => void {
  const probe = () => {
    if (!isSessionExpired() || !navigator.onLine) return;
    if (Date.now() - lastProbeAt < REPROBE_EVERY_MS) return;
    lastProbeAt = Date.now();
    void mint()
      .then((token) => {
        if (token) clearSessionExpired();
      })
      .catch(() => undefined);
  };
  const onVisible = () => {
    if (document.visibilityState === 'visible') probe();
  };
  window.addEventListener('online', probe);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('online', probe);
    document.removeEventListener('visibilitychange', onVisible);
  };
}

/** test seam: the next probe is allowed right away */
export function resetRevivalProbeForTests(): void {
  lastProbeAt = 0;
}

/** test seam — module state must not leak between specs */
export function resetSessionExpiryForTests(): void {
  expired = false;
  listeners.clear();
  lastBecameVisibleAt = 0;
  localStorage.removeItem(REENTRY_AT_KEY);
}
