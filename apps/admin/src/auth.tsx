import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useHandleSignInCallback, useLogto } from '@logto/react';
import { AdminApp } from './AdminApp';
import type { AdminConfig } from './config';

// prod Logto 2026-10-08: a DEAD grant was refreshed 669 times in 3 minutes (new getToken per render, remounts on isLoading
// flips, no memory of the dead grant)
// hence one getToken per session, a gate that stays mounted, a dead-grant flag, and a 15 s backoff on failures

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

// a dead grant asks nobody; a failed refresh waits 15 s, the request goes out without a bearer (the api's 401 answers)
// concurrent callers share one fetch: Logto rotates the refresh token, two at once revoke the grant family
// the SDK (4.x) swallows a failed refresh into undefined: undefined counts as a failure like a throw
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

export function LogtoGate({ config }: Readonly<{ config: AdminConfig }>) {
  const { error, isAuthenticated, isLoading, signIn, signOut, getAccessToken } = useLogto();
  const dead = useSyncExternalStore(subscribeGrant, isGrantDead);
  useEffect(() => {
    // the SDK swallows a failed refresh into this SHARED error; invalid_grant = the grant is spent and tokens never mint again
    // without a fresh sign-in: stop asking (a breadcrumb, not an event)
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
