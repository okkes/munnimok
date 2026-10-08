/**
 * Access-token bridge: the Logto provider (React context) registers a
 * getter here so non-React code (ApiSyncBackend) can fetch tokens.
 */
type TokenGetter = () => Promise<string | undefined>;

let getter: TokenGetter | null = null;

export function setAccessTokenGetter(fn: TokenGetter | null): void {
  getter = fn;
}

// ── auth readiness ───────────────────────────────────────────────────────
// On a cold PWA start the sync engine used to race Logto's session
// restore: the first requests went out without a token, got a 401 and
// poisoned the bootstrap. Sync now waits for this signal (the Logto
// provider fires it once restoring finished, either way).
let authReadyResolve: (() => void) | null = null;
const authReadyPromise = new Promise<void>((resolve) => {
  authReadyResolve = resolve;
});

export function signalAuthReady(): void {
  authReadyResolve?.();
  authReadyResolve = null;
}

/** resolves once the OIDC session restore finished (test auth: immediately) */
export function waitForAuthReady(): Promise<void> {
  return authReadyPromise;
}

// Single-flight: Logto ROTATES refresh tokens, so two concurrent refreshes
// race — the loser presents the already-consumed token and Logto revokes the
// whole grant family (dead refresh token → double 401 → forced re-login).
// Serializing concurrent callers onto one in-flight fetch removes the race.
let inflight: Promise<string | undefined> | null = null;

// #222: the single-flight only guards THIS context. An installed PWA
// window and a browser tab share the same localStorage refresh token and
// refresh independently — the loser presents the already-rotated token
// and Logto revokes the whole grant family (the "have to log out to get
// the connection back" state). A Web Lock serializes the refresh across
// every context of the origin; where unsupported, behavior is unchanged.
const withCrossTabLock = (fn: TokenGetter): Promise<string | undefined> =>
  typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('munni:oidc-token', fn) : fn();

// The single-flight folds CONCURRENT callers only: the very next call after
// a refresh that FAILED ran its own refresh again (prod Logto logs
// 2026-10-08: the admin portal hammered a dead grant 669 times in three
// minutes — the web app has the expiry mark, but a transient failure or a
// verdict the SDK swallowed left the same hole). After a failed attempt
// nobody asks Logto again for 15 s: callers get "no bearer" (the request
// goes out without one — a 401 that proves nothing, lib/api.ts) and the
// expiry handling or the revival probe decide what comes next. A minted
// token lifts the cooldown at once. The getter (features/auth/logto.tsx)
// is the attempt site, so only a real attempt arms it — never the
// expired-mark short-circuit.
export const REFRESH_RETRY_AFTER_MS = 15_000;
let retryAfter = 0;

export function noteRefreshFailed(): void {
  retryAfter = Date.now() + REFRESH_RETRY_AFTER_MS;
}

export function noteRefreshSucceeded(): void {
  retryAfter = 0;
}

export const isRefreshBackedOff = (): boolean => Date.now() < retryAfter;

/** test seam — the cooldown is module state and must not leak between specs */
export function resetRefreshBackoffForTests(): void {
  retryAfter = 0;
}

export async function getAccessToken(): Promise<string | undefined> {
  if (!getter) return undefined;
  if (isRefreshBackedOff()) return undefined;
  const current = getter;
  inflight ??= withCrossTabLock(current).finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Logto's signOut, registered by the provider (no-op when unconfigured). */
let signOutHandler: ((postLogoutRedirectUri: string) => Promise<void>) | null = null;

export function setOidcSignOut(fn: ((uri: string) => Promise<void>) | null): void {
  signOutHandler = fn;
}

export async function oidcSignOut(postLogoutRedirectUri: string): Promise<boolean> {
  if (!signOutHandler) return false;
  await signOutHandler(postLogoutRedirectUri);
  return true;
}

/**
 * Logto's signIn, registered by the provider — the 401 self-heal uses it
 * to re-enter the OIDC flow when a signed-in user has no mintable token
 * (evicted/wiped client keys while the IdP session cookie survives: the
 * round-trip is silent and re-mints tokens).
 */
let signInHandler: ((redirectUri: string, fresh?: boolean) => Promise<void>) | null = null;

export function setOidcSignIn(fn: ((uri: string, fresh?: boolean) => Promise<void>) | null): void {
  signInHandler = fn;
}

/** @param fresh asks Logto for credentials again (prompt=login consent): "use another account" */
export async function oidcSignIn(redirectUri: string, fresh = false): Promise<boolean> {
  if (!signInHandler) return false;
  await signInHandler(redirectUri, fresh);
  return true;
}
