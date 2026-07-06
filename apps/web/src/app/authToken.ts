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
