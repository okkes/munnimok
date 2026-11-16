import { config } from '@/app/config';
import { getAccessToken, waitForAuthReady } from '@/app/authToken';
import { readSessionIdentity } from '@/app/session';
import { protocolIssueFor } from './protocol';
import type { ProtocolIssue } from './protocol';
import { getDeviceId } from '@/db/device';
import { isNativeApp } from './platform';

function devicePlatform(): string {
  if (!isNativeApp()) return 'web';
  return /Android/i.test(navigator.userAgent) ? 'android' : 'ios';
}

/** every request names the calling device and platform: the server refuses device-less calls with 401 {device-required} */
export function deviceHeaders(): Record<string, string> {
  return { 'X-Munni-Device': getDeviceId(), 'X-Munni-Platform': devicePlatform() };
}

/** a 410 device-revoked from any endpoint means another device revoked this one (disconnect = wipe): data.tsx erases it */
export async function noticeDeviceRevoked(response: Response): Promise<void> {
  if (response.status !== 410) return;
  const body = await response.clone().json().catch(() => null);
  if ((body as { error?: string } | null)?.error === 'device-revoked') {
    globalThis.dispatchEvent(new CustomEvent('munni:device-revoked'));
  }
}

function assertNetworkAllowed(): void {
  const identity = readSessionIdentity();
  // the local-first law at the choke point: demo/offline identities never touch the network, whatever a screen forgets
  // to gate; signed out (null) stays allowed for login provisioning
  if (identity && identity.kind !== 'user') {
    throw new Error('local-only identity — API access denied');
  }
}

// one breadcrumb per page: a refused session is named once, however many background calls hit the 401
let handlingAuthExpiry = false;

/** test seam */
export function resetAuthExpiryGuard(): void {
  handlingAuthExpiry = false;
}

export async function apiFetch(
  path: string,
  init: RequestInit = {},
  opts?: {
    /** #281: statuses a caller handles as a designed branch (e.g. the /feeds 409 personal-feed fallback): not reported */
    expectStatuses?: readonly number[];
    /** the relay speaks for a PARTY: its 401 is the party's lapsed login, never munni's session: no retry, no expiry mark */
    partyAuth?: boolean;
  },
): Promise<Response> {
  assertNetworkAllowed();
  const identity = readSessionIdentity();
  // cold-start guard: screens fire requests before Logto restores the session; those went out bearer-less, hit 401 twice
  // and logged the user out, wiping a healthy refresh token, on every app update. Wait for the restore
  if (identity?.kind === 'user' && !identity.testAuth) await waitForAuthReady();
  let sentBearer = false;
  const attempt = async (): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Content-Type', 'application/json');
    for (const [name, value] of Object.entries(deviceHeaders())) headers.set(name, value);
    if (identity?.kind === 'user') {
      if (identity.testAuth) headers.set('X-User-Sub', identity.sub);
      else {
        const token = await getAccessToken();
        sentBearer = !!token;
        if (token) headers.set('Authorization', `Bearer ${token}`);
      }
    }
    return fetch(`${config.apiUrl}${path}`, { ...init, headers });
  };
  let response = await attempt();
  await noticeDeviceRevoked(response);
  if (response.status === 401 && identity?.kind === 'user' && !identity.testAuth && !opts?.partyAuth) {
    response = await attempt();
    // a 401 WITHOUT a bearer proves nothing about the refresh token —
    // only a rejected real token means the session is truly dead
    if (response.status === 401 && sentBearer) {
      // a fresh token still refused: the session is spent (IdP restart, revocation), retrying is useless
      // local-first: nobody is logged out or wiped; the offline banner offers Sign in (#222), near app open OIDC re-mints silently
      // a breadcrumb, not an event (GlitchTip 7/13/14): a sign-in that then fails reports from where it fails
      if (!handlingAuthExpiry) {
        handlingAuthExpiry = true;
        console.warn('session refused: double 401 on a fresh token — asking for a sign-in, nothing logged out');
      }
      const { markSessionExpired, attemptSilentReentry } = await import('@/app/sessionExpiry');
      if (markSessionExpired()) {
        const { oidcSignIn } = await import('@/app/authToken');
        const { callbackUri } = await import('@/features/auth/logto');
        void attemptSilentReentry(() => oidcSignIn(callbackUri()).then(() => undefined)).catch(() => undefined);
      }
    }
  }
  // #186: unexpected answers reach GlitchTip from here; 401/403/410 have own handlers, plain 4xx are the caller's business
  // 500 and 409 are "should not happen"; 502/503/504 are a gateway's or restart's answer, left to the callers' retry UI
  if ((response.status === 500 || response.status === 409) && !opts?.expectStatuses?.includes(response.status)) {
    const { reportWarning } = await import('@/lib/report');
    reportWarning('api', `apiFetch ${init.method ?? 'GET'} ${path} -> ${response.status}`, { status: response.status });
  }
  return response;
}

export interface ApiCapabilities {
  push?: boolean;
  vapidPublicKey?: string;
  /** logo.dev brand search proxy configured server-side */
  logos?: boolean;
  /** #521: the API searches the web for pictures (Brave Search key configured) */
  imageSearch?: boolean;
  /** #567: the API has a vision model read receipt photos (the reader's key configured) */
  receiptAi?: boolean;
  /** sign-up is closed: accounts come from invitation links (Logto's magic link, /invite) */
  inviteOnly?: boolean;
}

let capabilities: ApiCapabilities | null = null;
let protocolIssue: ProtocolIssue | null = null;

/** test seam: the per-page-load cache must not leak between test cases */
export function resetApiCapabilitiesCache(): void {
  capabilities = null;
  protocolIssue = null;
}

export const getProtocolIssue = (): ProtocolIssue | null => protocolIssue;

/** false until /health has answered: an empty answer from getApiCapabilities then means "could not ask", not "offers nothing" */
export const apiCapabilitiesKnown = (): boolean => capabilities !== null;

export async function getApiCapabilities(): Promise<ApiCapabilities> {
  if (capabilities) return capabilities;
  const identity = readSessionIdentity();
  // offline identities get "no server features" without a network call, and uncached in case a user signs in later
  if (identity && identity.kind !== 'user') return {};
  try {
    const res = await fetch(`${config.apiUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as {
      capabilities?: ApiCapabilities;
      protocol: number;
      minClientProtocol: number;
    };
    protocolIssue = protocolIssueFor(body);
    capabilities = body.capabilities ?? {};
    return capabilities;
  } catch {
    // transient failure (booted offline): answer "no features" but do not cache it, the next caller retries
    return {};
  }
}
