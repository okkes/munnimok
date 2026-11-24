import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { useHandleSignInCallback, useLogto } from '@logto/react';
import { ControlApp } from './ControlApp';
import type { ControlConfig } from './config';

// a refresh grant that died is never refreshed again, yet the SDK still reports a signed-in person: every token call
// flipped isLoading, a gate that unmounted on the flip reloaded the console, and the console asked again — the page
// flickered and the dead grant was sent over and over (#681; apps/admin/src/auth.tsx carries the same guard)

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

// a dead grant asks nobody; a failed refresh waits, the request goes out without a bearer (the api's 401 answers)
// concurrent callers share one fetch: Logto rotates the refresh token, two at once revoke the grant family
// the SDK swallows a failed refresh into undefined: undefined counts as a failure like a throw
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

export function LogtoGate({ config }: Readonly<{ config: ControlConfig }>) {
  const { error, isAuthenticated, isLoading, signIn, signOut, getAccessToken } = useLogto();
  const dead = useSyncExternalStore(subscribeGrant, isGrantDead);
  useEffect(() => {
    // the SDK swallows a failed refresh into this SHARED error; invalid_grant = tokens never mint again without a fresh sign-in
    if (error && isInvalidGrantError(error) && markGrantDead()) {
      console.warn('refresh grant dead: invalid_grant on token refresh — no more refreshes until the operator signs in again');
    }
  }, [error]);
  // ONE function per session: a new one per render re-ran the console's load on every isLoading flip
  const getToken = useCallback(
    () => fetchTokenGuarded(() => getAccessToken(config.logtoResource || undefined)),
    [getAccessToken, config.logtoResource],
  );
  const callback = `${window.location.origin}/auth-callback`;
  if (window.location.pathname.endsWith('/auth-callback')) return <Callback />;
  // only the initial restore shows the dots — once signed in the console stays mounted through the SDK's isLoading flips
  if (isLoading && !isAuthenticated) return <p className="center">…</p>;
  // a dead grant is a signed-out person as far as the API goes: the way back in is the same door
  if (!isAuthenticated || dead) {
    return (
      <div className="center">
        {dead && (
          <p className="denied" data-testid="session-expired">
            Your session expired — sign in again.
          </p>
        )}
        <button className="btn" data-testid="signin" onClick={() => void signIn(callback)}>
          Sign in
        </button>
        <p className="hint">
          Same account as the munni app — there is no admin password. An operator grants admin per account in the setup wizard (the
          environment&apos;s Access tab).
        </p>
      </div>
    );
  }
  return <ControlApp config={config} getToken={getToken} signOut={() => void signOut(window.location.origin)} />;
}

export function Callback() {
  useHandleSignInCallback(() => window.location.replace(window.location.origin));
  return <p className="center">…</p>;
}
