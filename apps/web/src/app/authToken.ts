type TokenGetter = () => Promise<string | undefined>;

let getter: TokenGetter | null = null;

export function setAccessTokenGetter(fn: TokenGetter | null): void {
  getter = fn;
}

// sync waits for this signal: on a cold PWA start it raced Logto's session restore, went out
// tokenless and the 401 poisoned the bootstrap
let authReadyResolve: (() => void) | null = null;
const authReadyPromise = new Promise<void>((resolve) => {
  authReadyResolve = resolve;
});

export function signalAuthReady(): void {
  authReadyResolve?.();
  authReadyResolve = null;
}

/** #594: a wait past its limit counts as lost (a phone sat on the connecting screen with nothing failing): requests go out
 * without a bearer and the 401 path takes over */
export const AUTH_READY_WAIT_MS = 15_000;
export const TOKEN_MINT_WAIT_MS = 20_000;

/** what the two waits came to — the connecting screen's diagnosis reads it */
const waits: { restore: 'pending' | 'done' | 'timed out'; mint: 'ok' | 'timed out' } = { restore: 'pending', mint: 'ok' };
export const authWaits = (): Readonly<typeof waits> => waits;

let restoreDeadline: ReturnType<typeof setTimeout> | null = null;

export function waitForAuthReady(): Promise<void> {
  // the first waiter starts the clock: a restore nobody waits for needs none
  if (authReadyResolve) {
    restoreDeadline ??= setTimeout(() => {
      if (!authReadyResolve) return;
      waits.restore = 'timed out';
      signalAuthReady();
    }, AUTH_READY_WAIT_MS);
  }
  return authReadyPromise.then(() => {
    if (waits.restore === 'pending') waits.restore = 'done';
  });
}

// single-flight: Logto rotates refresh tokens, so concurrent refreshes race and the loser's
// consumed token revokes the grant family
let inflight: Promise<string | undefined> | null = null;

// #222: an installed PWA window and a browser tab share one refresh token and refresh independently;
// a Web Lock serializes it
const withCrossTabLock = (fn: TokenGetter): Promise<string | undefined> =>
  !lockStuck && typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('munni:oidc-token', fn) : fn();

// a mint that never answered still holds the lock: the mints after it would queue behind it for good
let lockStuck = false;

/** a mint past its limit counts as a failed refresh: the next callers ask nobody for a while */
function withinLimit(mint: Promise<string | undefined>): Promise<string | undefined> {
  let limit: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    limit = setTimeout(() => {
      waits.mint = 'timed out';
      lockStuck = true;
      noteRefreshFailed();
      resolve(undefined);
    }, TOKEN_MINT_WAIT_MS);
  });
  return Promise.race([mint, late]).finally(() => clearTimeout(limit));
}

// the single-flight folds concurrent callers only; after a failed refresh nobody asks Logto for 15 s
// (prod 2026-10-08: 669 refreshes of a dead grant in three minutes); a minted token lifts the cooldown;
// only the getter arms it, so the expired-mark short-circuit never does
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
  // `lockStuck` stays: a mint that never answered holds the lock for the life of the process
  waits.mint = 'ok';
}

export async function getAccessToken(): Promise<string | undefined> {
  if (!getter) return undefined;
  if (isRefreshBackedOff()) return undefined;
  const current = getter;
  inflight ??= withinLimit(withCrossTabLock(current)).finally(() => {
    inflight = null;
  });
  return inflight;
}

let signOutHandler: ((postLogoutRedirectUri: string) => Promise<void>) | null = null;

export function setOidcSignOut(fn: ((uri: string) => Promise<void>) | null): void {
  signOutHandler = fn;
}

export async function oidcSignOut(postLogoutRedirectUri: string): Promise<boolean> {
  if (!signOutHandler) return false;
  await signOutHandler(postLogoutRedirectUri);
  return true;
}

/** the 401 self-heal re-enters the OIDC flow when a signed-in user has no mintable token
 * (client keys wiped, IdP cookie alive) */
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
