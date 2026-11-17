import { clearStaleLogtoState } from '@/lib/authState';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { LogtoProvider, useHandleSignInCallback, useLogto, Prompt } from '@logto/react';
import * as Sentry from '@sentry/react';
import { config, logtoConfigured } from '@/app/config';
import { NATIVE_CALLBACK_KEY, isNativeApp } from '@/lib/platform';
import { NativeLogtoClient, nativeCallbackUri } from './nativeAuth';
import {
  noteRefreshFailed,
  noteRefreshSucceeded,
  setAccessTokenGetter,
  setOidcSignIn,
  setOidcSignOut,
  signalAuthReady,
} from '@/app/authToken';
import {
  attemptSilentReentry,
  clearReentryMark,
  clearSessionExpired,
  isInvalidGrantError,
  isSessionExpired,
  markSessionExpired,
  watchForRevival,
} from '@/app/sessionExpiry';
import { useSession } from '@/app/session';
import { takeAfterLogin } from '@/app/afterLogin';
import { continueOptions, readLastAccount, readSignInWay, rememberLastAccount } from './lastAccount';
import { Logo } from '@/ui/Logo';

// OIDC redirect URIs cannot contain fragments: the callback lands on a real path (/auth-callback) outside the hash router.
// The native shell uses its custom scheme instead: munni://auth-callback and munni-dev://auth-callback must be
// registered in Logto's redirect URIs; the deep-link handler re-enters /auth-callback with the same params.
export const callbackUri = () =>
  isNativeApp() ? nativeCallbackUri() : `${window.location.origin}/auth-callback`;
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
        // #559: userinfo names the account's social identities — how "Continue as" gets back in.
        // A refresh never sends scopes, so the sessions granted before this keep working.
        scopes: ['identities'],
      }}
      LogtoClientClass={isNativeApp() ? NativeLogtoClient : undefined}
    >
      <TokenBridge />
      {children}
    </LogtoProvider>
  );
}

function TokenBridge() {
  const { error, getAccessToken, isAuthenticated, isLoading, signIn, signOut } = useLogto();
  // #559: the same person signs in the way they came in: Logto's session continues, once gone straight to their provider
  const continueSignIn = useCallback((uri: string) => signIn({ redirectUri: uri, ...continueOptions(readLastAccount()) }), [signIn]);
  useEffect(() => {
    setOidcSignOut((uri) => signOut(uri));
    // prompt=login makes Logto ask for credentials with its session alive;
    // consent keeps the refresh token (login alone issues none)
    setOidcSignIn((uri, fresh) => (fresh ? signIn({ redirectUri: uri, prompt: [Prompt.Login, Prompt.Consent] }) : continueSignIn(uri)));
    return () => {
      setOidcSignOut(null);
      setOidcSignIn(null);
    };
  }, [signIn, signOut, continueSignIn]);
  useEffect(() => {
    // #222: the SDK swallows refresh failures into the SHARED context error; invalid_grant means the refresh grant is spent,
    // so tokens never mint again without a fresh sign-in: report once, and near app open silently re-enter the OIDC flow.
    // Never during the callback exchange: its errors have their own wipe handling.
    if (!error || isCallbackPath() || !isInvalidGrantError(error)) return;
    if (markSessionExpired()) {
      // a breadcrumb, not an event: the re-entry or the banner handles it; a sign-in that then fails reports where it fails
      console.warn('refresh grant dead: invalid_grant on token refresh — re-entering sign-in');
      void attemptSilentReentry(() => continueSignIn(callbackUri()));
    }
  }, [error, continueSignIn]);
  useEffect(() => {
    // the SDK flips isLoading for EVERY call, its own getAccessToken included: only the initial restore keeps sync waiting,
    // else the first sync went out without a bearer
    if (isLoading && !isAuthenticated) return;
    if (isAuthenticated) {
      setAccessTokenGetter(async () => {
        // a spent grant never mints again — stop hammering the IdP
        if (isSessionExpired()) return undefined;
        try {
          const token = (await getAccessToken(config.logto.resource || undefined)) ?? undefined;
          if (token) {
            clearSessionExpired();
            clearReentryMark();
            noteRefreshSucceeded();
            return token;
          }
          // the SDK (4.x) swallows a failed refresh into its shared error and answers undefined: count it as failed,
          // so the callers of the next 15 s ask nobody
          noteRefreshFailed();
          return undefined;
        } catch (err) {
          noteRefreshFailed();
          // a client that throws instead: read the verdict here too — a breadcrumb, not an event
          if (isInvalidGrantError(err) && markSessionExpired()) {
            console.warn('refresh grant dead: invalid_grant from the token getter — asking for a sign-in');
            void attemptSilentReentry(() => continueSignIn(callbackUri())).catch(() => undefined);
          }
          return undefined;
        }
      });
    } else {
      setAccessTokenGetter(null);
    }
    signalAuthReady(); // restore finished (either outcome) — sync may start
    return () => setAccessTokenGetter(null);
  }, [getAccessToken, isAuthenticated, isLoading, continueSignIn]);
  useEffect(() => {
    if (!isAuthenticated) return;
    return watchForRevival(async () => {
      const token = (await getAccessToken(config.logto.resource || undefined)) ?? undefined;
      if (token) noteRefreshSucceeded(); // the probe minted — the bridge's cooldown ends with the mark
      return token;
    });
  }, [getAccessToken, isAuthenticated]);
  return null;
}

function useFinishSignIn(): (getToken?: () => Promise<string | null | undefined>) => Promise<boolean> {
  const { getIdTokenClaims } = useLogto();
  const login = useSession((s) => s.login);
  return async (getToken) => {
    const claims = await getIdTokenClaims();
    // no readable identity: the caller shows retry instead of bouncing a session-less user into the app
    if (!claims?.sub) return false;
    login({ kind: 'user', sub: claims.sub });
    // #559: how this account gets back in — asked beside the display-name write below, never after it
    const way = readSignInWay(config.logto.endpoint, claims.username, getToken);
    // AWAITED with a cap: fire-and-forget raced the /#/home navigation, iOS WebKit cancels the in-flight fetch and the shared
    // context error then triggered the post-login key wipe
    const name = claims.name ?? claims.username ?? claims.email;
    if (name) {
      const { apiFetch } = await import('@/lib/api');
      await Promise.race([
        apiFetch('/me', { method: 'PUT', body: JSON.stringify({ displayName: name }) }).catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ]);
    }
    rememberLastAccount(name, await way);
    window.location.replace(`${window.location.origin}/#${takeAfterLogin() ?? '/home'}`);
    return true;
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

// native: the webview lands on https://localhost/auth-callback but the exchange must present the ORIGINAL munni:// url as
// redirect_uri (the SDK checks the callback url starts with the stored one); so a fresh client is driven with the deep-link
// url, sharing the sign-in session (localStorage keyed by appId)
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
      await client.handleSignInCallback(url);
      sessionStorage.removeItem(NATIVE_CALLBACK_KEY);
      // this client holds the token the exchange minted — the provider's own would refresh for it
      if (!(await finish(() => client.getAccessToken()))) setFailed('no identity claims');
    })().catch((err: unknown) => {
      sessionStorage.removeItem(NATIVE_CALLBACK_KEY);
      // shown on screen AND reported (a native user has no devtools), unless it is a stale callback the fresh sign-in answers
      if (!isStaleCallbackError(err)) Sentry.captureException(err);
      // a failed exchange leaves poisoned SDK state: clear it so the retry starts a fresh sign-in
      clearStaleLogtoState('native-callback-error');
      setFailed(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <CallbackShell failed={failed !== null} detail={failed ?? undefined} />;
}

// a callback whose state no longer matches: its sign-in was started over (second tap/tab, retry); the fresh sign-in
// is the handling, not an incident (GlitchTip 16)
export function isStaleCallbackError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /state mismatch/i.test(message);
}

function WebCallbackScreen() {
  const finish = useFinishSignIn();
  const { getAccessToken } = useLogto();
  const [noClaims, setNoClaims] = useState(false);
  const { error, isAuthenticated } = useHandleSignInCallback(() => {
    // the exchange's own token, still cached — no refresh behind it
    void finish(() => getAccessToken()).then((ok) => {
      if (!ok) setNoClaims(true);
    });
  });
  useEffect(() => {
    if (!error) return;
    if (!isStaleCallbackError(error)) Sentry.captureException(error);
    // wipe ONLY while the exchange itself failed: the context error is SHARED (iOS cancels the display-name PUT), and wiping
    // then left a signed-in user with no Logto keys, a 401 loop
    if (!isAuthenticated) clearStaleLogtoState('web-callback-error');
  }, [error, isAuthenticated]);
  return <CallbackShell failed={Boolean(error) || noClaims} detail={error ? `${error.name}: ${error.message}` : undefined} />;
}

export function CallbackScreen() {
  const nativeUrl = sessionStorage.getItem(NATIVE_CALLBACK_KEY);
  return nativeUrl ? <NativeCallbackScreen url={nativeUrl} /> : <WebCallbackScreen />;
}
