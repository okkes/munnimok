import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { LogtoProvider, useHandleSignInCallback, useLogto } from '@logto/react';
import { config, logtoConfigured } from '@/app/config';
import { isNativeApp } from '@/lib/platform';
import { setAccessTokenGetter, setOidcSignOut, signalAuthReady } from '@/app/authToken';
import { useSession } from '@/app/session';
import { Logo } from '@/ui/Logo';

/**
 * OIDC redirect URIs cannot contain fragments, so the callback lands on a
 * real path (/auth-callback) *outside* the hash router; after processing we
 * jump back into the app shell. The native shell signs in via its custom
 * scheme instead (register munni://auth-callback in Logto's redirect URIs);
 * the deep-link handler re-enters /auth-callback with the same params.
 */
export const callbackUri = () => (isNativeApp() ? 'munni://auth-callback' : `${window.location.origin}/auth-callback`);
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

/** rendered at /auth-callback: finishes the OIDC exchange, then re-enters the app */
export function CallbackScreen() {
  const { getIdTokenClaims } = useLogto();
  const login = useSession((s) => s.login);

  const { isLoading } = useHandleSignInCallback(() => {
    void (async () => {
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
    })();
  });

  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4 bg-bg" data-testid="screen-auth-callback">
      <Logo size={36} />
      {isLoading && <div className="text-sm text-ink-3">…</div>}
    </div>
  );
}
