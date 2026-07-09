import { config } from '@/app/config';
import { getAccessToken } from '@/app/authToken';
import { readSessionIdentity } from '@/app/session';

/** rejects API access for identities that promised to stay offline */
function assertNetworkAllowed(): void {
  const identity = readSessionIdentity();
  // the local-first law, enforced at the choke point: demo/offline
  // identities never touch the network, whatever a screen forgets to
  // gate. Signed out (null) stays allowed — login provisioning needs it.
  if (identity && identity.kind !== 'user') {
    throw new Error('local-only identity — API access denied');
  }
}

/** Authenticated fetch to the munni API for the current user identity. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  assertNetworkAllowed();
  const identity = readSessionIdentity();
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (identity?.kind === 'user') {
    if (identity.testAuth) headers.set('X-User-Sub', identity.sub);
    else {
      const token = await getAccessToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }
  }
  return fetch(`${config.apiUrl}${path}`, { ...init, headers });
}

export interface ApiCapabilities {
  gocardless: boolean;
  push?: boolean;
  vapidPublicKey?: string;
  /** logo.dev brand search proxy configured server-side */
  logos?: boolean;
}

let capabilities: ApiCapabilities | null = null;

/** test seam: the per-page-load cache must not leak between test cases */
export function resetApiCapabilitiesCache(): void {
  capabilities = null;
}

/** Server feature flags from /health (cached per page load). */
export async function getApiCapabilities(): Promise<ApiCapabilities> {
  if (capabilities) return capabilities;
  const identity = readSessionIdentity();
  // offline identities get the "no server features" answer without a
  // network call — and without caching it, in case a user signs in later
  if (identity && identity.kind !== 'user') return { gocardless: false };
  try {
    const res = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { capabilities?: ApiCapabilities };
    capabilities = body.capabilities ?? { gocardless: false };
    return capabilities;
  } catch {
    // transient failure (booted offline, radio still asleep): answer "no
    // features" but do NOT cache it — the next caller gets a fresh try
    return { gocardless: false };
  }
}
