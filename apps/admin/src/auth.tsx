import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useHandleSignInCallback, useLogto } from '@logto/react';
import { AdminApp } from './AdminApp';
import type { AdminConfig } from './config';

/**
 * The portal's token path and its guard. Prod Logto logs 2026-10-08: the
 * portal asked Logto to refresh a DEAD grant 669 times between 20:02 and
 * 20:05 on 2026-10-06. Three things fed the storm: every render handed
 * AdminApp a new getToken, so its reload effect ran again; the SDK flips
 * isLoading on every token call and the gate unmounted AdminApp on each
 * flip and mounted it afresh — another reload; and nothing remembered that
 * the grant was dead, so every call ran the refresh once more. Now: one
 * getToken per session, the gate stays mounted once signed in, a dead
 * grant is a module flag that stops every refresh until the operator signs
 * in again, and any failed refresh is left alone for 15 s.
 */

/** Logto's verdict on a spent refresh grant, in either error shape (the LogtoRequestError code, or the message the react proxy re-wraps) */
export function isInvalidGrantError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const rawCode = (err as { code?: unknown }).code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  const message = err instanceof Error ? err.message : '';
  return code.includes('invalid_grant') || message.includes('Grant request is invalid');
}

let grantDead = false;
const listeners = new Set<() => void>();

/** true on the marking transition only — the breadcrumb is written once */
export function markGrantDead(): boolean {
  if (grantDead) return false;
  grantDead = true;
  for (const listener of listeners) listener();
  return true;
}

export const isGrantDead = (): boolean => grantDead;

export function subscribeGrant(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** after a refresh that failed, nobody asks Logto again for this long */
export const REFRESH_RETRY_AFTER_MS = 15_000;
let retryAfter = 0;
let inflight: Promise<string | undefined> | null = null;

/**
 * The guarded token fetch: a dead grant asks nobody (the banner's Sign in
 * is the way back); a refresh that failed is not tried again for 15 s — the
 * request goes out without a bearer and the api's 401 is the honest answer;
 * concurrent callers share one in-flight fetch (Logto rotates the SPA's
 * refresh token — two refreshes at once revoke the whole grant family).
 * The SDK (4.x) swallows a failed refresh into its context error and answers
 * undefined, so an undefined answer counts as a failed attempt as much as a
 * throw does.
 */
export function fetchTokenGuarded(fetchToken: () => Promise<string | undefined>): Promise<string | undefined> {
  if (grantDead || Date.now() < retryAfter) return Promise.resolve(undefined);
  inflight ??= fetchToken()
    .then((token) => {
      retryAfter = token ? 0 : Date.now() + REFRESH_RETRY_AFTER_MS;
      return token;
    })
    .catch(() => {
      retryAfter = Date.now() + REFRESH_RETRY_AFTER_MS;
      return undefined;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/** test seam — module state must not leak between specs */
export function resetAuthForTests(): void {
  grantDead = false;
  listeners.clear();
  retryAfter = 0;
  inflight = null;
}

/** OIDC gate: the sign-in door, the callback, and the signed-in portal with its guarded token path */
export function LogtoGate({ config }: Readonly<{ config: AdminConfig }>) {
  const { error, isAuthenticated, isLoading, signIn, signOut, getAccessToken } = useLogto();
  const dead = useSyncExternalStore(subscribeGrant, isGrantDead);
  useEffect(() => {
    // the SDK swallows a failed refresh into this SHARED error; invalid_grant
    // is Logto's verdict that the grant is spent — tokens never mint again
    // without a fresh sign-in, so stop asking (a breadcrumb, not an event)
    if (error && isInvalidGrantError(error) && markGrantDead()) {
      console.warn('refresh grant dead: invalid_grant on token refresh — no more refreshes until the operator signs in again');
    }
  }, [error]);
  // ONE function per session: a new one per render re-ran AdminApp's reload effect on every isLoading flip
  const getToken = useCallback(
    () => fetchTokenGuarded(() => getAccessToken(config.logtoResource || undefined)),
    [getAccessToken, config.logtoResource],
  );
  const callback = `${window.location.origin}/auth-callback`;
  const isCallback = window.location.pathname.endsWith('/auth-callback');
  if (isCallback) return <Callback />;
  // only the initial restore shows the dots — once signed in the portal stays mounted through the SDK's isLoading flips
  if (isLoading && !isAuthenticated) return <p className="center">…</p>;
  if (!isAuthenticated) {
    return (
      <div className="center">
        <button className="btn" onClick={() => void signIn(callback)}>
          Sign in
        </button>
        <p className="hint">
          Same account as the munni app — there is no admin password. An operator grants admin per account in the setup wizard (the
          environment&apos;s Access tab).
        </p>
      </div>
    );
  }
  return (
    <AdminApp
      config={config}
      getToken={getToken}
      signOut={() => void signOut(window.location.origin)}
      session={{ expired: dead, signIn: () => void signIn(callback) }}
    />
  );
}

export function Callback() {
  useHandleSignInCallback(() => window.location.replace(window.location.origin));
  return <p className="center">…</p>;
}
