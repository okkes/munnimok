/**
 * Access-token bridge: the Logto provider (React context) registers a
 * getter here so non-React code (ApiSyncBackend) can fetch tokens.
 */
type TokenGetter = () => Promise<string | undefined>;

let getter: TokenGetter | null = null;

export function setAccessTokenGetter(fn: TokenGetter | null): void {
  getter = fn;
}

export async function getAccessToken(): Promise<string | undefined> {
  return getter ? await getter() : undefined;
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
