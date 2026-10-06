import { deviceId } from './device';

/**
 * The lab's one door to the munni API: every call carries the device
 * header, the bearer (or the test-auth subject), and JSON. Errors come
 * back as the api's plain string or the connector's envelope
 * ({ error: { code, … } }) — `reasonOf` reads both.
 */
export interface LabAuth {
  /** null = test-auth mode (X-User-Sub from the settings box) */
  getToken: (() => Promise<string | undefined>) | null;
  sub: string;
}

export type Call = (path: string, init?: RequestInit) => Promise<Response>;

export function createCall(apiUrl: string, auth: LabAuth): Call {
  return async (path, init = {}) => {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    headers.set('X-Munni-Device', deviceId());
    headers.set('X-Munni-Platform', 'web');
    if (auth.getToken) {
      const token = await auth.getToken();
      if (token) headers.set('Authorization', `Bearer ${token}`);
    } else if (auth.sub) {
      headers.set('X-User-Sub', auth.sub);
    }
    return fetch(`${apiUrl}${path}`, { ...init, headers });
  };
}

/** the reason a refused answer carries: the api's string, the connector's code, or the status */
export async function reasonOf(res: Response | null): Promise<string> {
  if (!res) return 'network';
  const body = (await res.json().catch(() => null)) as { error?: string | { code?: string; detailId?: string } } | null;
  if (typeof body?.error === 'string') return body.error;
  if (body?.error?.code) return body.error.detailId ? `${body.error.code} (${body.error.detailId})` : body.error.code;
  return `HTTP ${res.status}`;
}

/** GET as JSON, or null when the route answers 404 (an environment without connectors) */
export async function getJson<T>(call: Call, path: string): Promise<T | null | 'unreachable'> {
  const res = await call(path).catch(() => null);
  if (!res) return 'unreachable';
  if (res.status === 404) return null;
  if (!res.ok) return 'unreachable';
  return (await res.json()) as T;
}
