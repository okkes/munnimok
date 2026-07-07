import { config } from '@/app/config';
import { getAccessToken } from '@/app/authToken';
import { readSessionIdentity } from '@/app/session';

/** Authenticated fetch to the munni API for the current user identity. */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
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
}

let capabilities: ApiCapabilities | null = null;

/** Server feature flags from /health (cached per page load). */
export async function getApiCapabilities(): Promise<ApiCapabilities> {
  if (capabilities) return capabilities;
  try {
    const res = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { capabilities?: ApiCapabilities };
    capabilities = body.capabilities ?? { gocardless: false };
  } catch {
    capabilities = { gocardless: false };
  }
  return capabilities;
}
