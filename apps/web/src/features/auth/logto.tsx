import { clearStaleLogtoState } from '@/lib/authState';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LogtoProvider, useHandleSignInCallback, useLogto } from '@logto/react';
import * as Sentry from '@sentry/react';
import { config, logtoConfigured, publicOrigin } from '@/app/config';
import { NATIVE_CALLBACK_KEY, isNativeApp } from '@/lib/platform';
import { setAccessTokenGetter, setOidcSignOut, signalAuthReady } from '@/app/authToken';
import { useSession } from '@/app/session';
import { Logo } from '@/ui/Logo';

/**
 * OIDC redirect URIs cannot contain fragments, so the callback lands on a
 * real path (/auth-callback) *outside* the hash router; after processing we
 * jump back into the app shell. The native shell signs in via its custom
 * scheme instead (register munni://auth-callback — and the staging app's
 * munni-dev://auth-callback — in Logto's redirect URIs); the deep-link
 * handler re-enters /auth-callback with the same params.
 */
export const callbackUri = () =>
  // native uses the UNIVERSAL LINK return (no "Open in munni?" popup);
  // the hosted /native-auth page scheme-bounces when the link fails
  isNativeApp() ? `${publicOrigin()}/native-auth` : `${window.location.origin}/auth-callback`;
export const isCallbackPath = () => window.location.pathname.endsWith('/auth-callback');

export function LogtoAppProvider({ children }: { children: ReactNode }) {
  if (!logtoConfigured) {
    signalAuthReady(); // no OIDC in play (test auth / local) — nothing to wait for
    return children;
  }
  return (
    <LogtoProvider
      config={{
        endpoint: config.logto.endpoint,
        appId: config.logto.appId,
        resources: config.logto.resource ? [config.logto.resource] : [],
      }}
    >
      <TokenBridge />
      {children}
    </LogtoProvider>
  );
}

/** exposes Logto access tokens + signOut to non-React code */
function TokenBridge() {
  const { getAccessToken, isAuthenticated, isLoading, signOut } = useLogto();
  useEffect(() => {
    setOidcSignOut((uri) => signOut(uri));
    return () => setOidcSignOut(null);
  }, [signOut]);
  useEffect(() => {
    if (isLoading) return; // session still restoring — keep sync waiting
    if (isAuthenticated) {
      setAccessTokenGetter(async () => {
        try {
          return (await getAccessToken(config.logto.resource || undefined)) ?? undefined;
        } catch {
          return undefined;
        }
      });
    } else {
      setAccessTokenGetter(null);
    }
    signalAuthReady(); // restore finished (either outcome) — sync may start
    return () => setAccessTokenGetter(null);
  }, [getAccessToken, isAuthenticated, isLoading]);
  return null;
}

/** shared post-exchange step: adopt the session, then re-enter the app */
function useFinishSignIn(): () => Promise<void> {
  const { getIdTokenClaims } = useLogto();
  const login = useSession((s) => s.login);
  return async () => {
    const claims = await getIdTokenClaims();
    if (claims?.sub) {
      login({ kind: 'user', sub: claims.sub });
      // best-effort display name for friends/space members
      const name = claims.name ?? claims.username ?? claims.email;
      if (name) {
        const { apiFetch } = await import('@/lib/api');
        void apiFetch('/me', { method: 'PUT', body: JSON.stringify({ displayName: name }) }).catch(() => undefined);
      }
    }
    window.location.replace(`${window.location.origin}/#/home`);
  };
}

function CallbackShell({ failed, detail }: Readonly<{ failed?: boolean; detail?: string }>) {
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg" data-testid="screen-auth-callback">
      <Logo size={36} />
      {failed ? (
        <>
          <button
            data-testid="auth-callback-retry"
            onClick={() => window.location.replace(window.location.origin)}
            className="m-tap rounded-full border border-line bg-surface px-4 py-2 text-sm text-ink"
          >
            ↺
          </button>
          {detail ? (
            <div data-testid="auth-callback-error" className="max-w-[280px] break-words text-center text-[11px] text-ink-3">
              {detail}
            </div>
          ) : null}
        </>
      ) : (
        <div className="text-sm text-ink-3">…</div>
      )}
    </div>
  );
}

/**
 * Native shell: the webview lands here as https://localhost/auth-callback,
 * but the code exchange must present the ORIGINAL munni:// url as its
 * redirect_uri — the SDK checks that the callback url starts with the
 * stored redirect_uri, so localhost is rejected (this was the
 * stuck-at-logo bug). The React hook only ever sees window.location, so
 * we drive a fresh client with the deep-link url instead; it shares the
 * sign-in session (localStorage keyed by appId) with the provider.
 */
function NativeCallbackScreen({ url }: Readonly<{ url: string }>) {
  const finish = useFinishSignIn();
  const [failed, setFailed] = useState<string | null>(null);
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    void (async () => {
      const { default: LogtoClient } = await import('@logto/browser');
      const client = new LogtoClient({
        endpoint: config.logto.endpoint,
        appId: config.logto.appId,
        resources: config.logto.resource ? [config.logto.resource] : [],
      });
      // scheme-bounced fallback stored only the path — re-anchor it on
      // the public origin so it matches the registered redirect_uri
      await client.handleSignInCallback(url.startsWith('/') ? `${publicOrigin()}${url}` : url);
      sessionStorage.removeItem(NATIVE_CALLBACK_KEY);
      await finish();
    })().catch((err: unknown) => {
      sessionStorage.removeItem(NATIVE_CALLBACK_KEY);
      // shown on screen AND reported: a native user cannot open devtools
      Sentry.captureException(err);
      // a failed exchange leaves poisoned SDK state behind — clear it so
      // the retry starts a fresh sign-in (password-change loop fix)
      clearStaleLogtoState();
      setFailed(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <CallbackShell failed={failed !== null} detail={failed ?? undefined} />;
}

function WebCallbackScreen() {
  const finish = useFinishSignIn();
  const { error } = useHandleSignInCallback(() => void finish());
  if (error) {
    Sentry.captureException(error);
    clearStaleLogtoState(); // poisoned exchange state must not survive into the retry
  }
  return <CallbackShell failed={Boolean(error)} detail={error ? `${error.name}: ${error.message}` : undefined} />;
}

/** rendered at /auth-callback: finishes the OIDC exchange, then re-enters the app */
export function CallbackScreen() {
  const nativeUrl = sessionStorage.getItem(NATIVE_CALLBACK_KEY);
  return nativeUrl ? <NativeCallbackScreen url={nativeUrl} /> : <WebCallbackScreen />;
}
