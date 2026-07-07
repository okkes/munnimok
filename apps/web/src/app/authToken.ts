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
