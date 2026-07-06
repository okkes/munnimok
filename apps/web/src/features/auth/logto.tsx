import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { LogtoProvider, useHandleSignInCallback, useLogto } from '@logto/react';
import { config, logtoConfigured } from '@/app/config';
import { setAccessTokenGetter, setOidcSignOut } from '@/app/authToken';
import { useSession } from '@/app/session';
import { Logo } from '@/ui/Logo';

/**
 * OIDC redirect URIs cannot contain fragments, so the callback lands on a
 * real path (/auth-callback) *outside* the hash router; after processing we
 * jump back into the app shell.
 */
export const callbackUri = () => `${window.location.origin}/auth-callback`;
export const isCallbackPath = () => window.location.pathname.endsWith('/auth-callback');

export function LogtoAppProvider({ children }: { children: ReactNode }) {
  if (!logtoConfigured) return children;
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
  const { getAccessToken, isAuthenticated, signOut } = useLogto();
  useEffect(() => {
    setOidcSignOut((uri) => signOut(uri));
    return () => setOidcSignOut(null);
  }, [signOut]);
  useEffect(() => {
    if (!isAuthenticated) {
      setAccessTokenGetter(null);
      return;
    }
    setAccessTokenGetter(async () => {
      try {
        return (await getAccessToken(config.logto.resource || undefined)) ?? undefined;
      } catch {
        return undefined;
      }
    });
    return () => setAccessTokenGetter(null);
  }, [getAccessToken, isAuthenticated]);
  return null;
}

/** rendered at /auth-callback: finishes the OIDC exchange, then re-enters the app */
export function CallbackScreen() {
  const { getIdTokenClaims } = useLogto();
  const login = useSession((s) => s.login);

  const { isLoading } = useHandleSignInCallback(() => {
    void (async () => {
      const claims = await getIdTokenClaims();
      if (claims?.sub) login({ kind: 'user', sub: claims.sub });
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
