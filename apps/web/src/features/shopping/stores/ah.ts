import type { AhReceiptSummary, AhReceiptUiItem } from '@/domain/storeReceipts';

/**
 * Albert Heijn adapter (receipts design S2), per the community recipe
 * (appie-go / the receipts gist): the mobile app's own endpoints behind
 * our CORS pass-through. The user logs in at login.ah.nl in their own
 * browser tab; AH redirects to appie://login-exit?code=… which the
 * browser can't open — the user pastes that address back and the code
 * is exchanged for tokens that never leave the device.
 */

export const AH_AUTHORIZE_URL =
  'https://login.ah.nl/secure/oauth/authorize?client_id=appie&redirect_uri=appie%3A%2F%2Flogin-exit&response_type=code';

const CLIENT_ID = 'appie';

/** one proxied call: the server forwards verbatim, stores nothing */
export type ProxyCall = (
  store: 'ah-api' | 'ah-login',
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: unknown; authorization?: string },
) => Promise<{ status: number; json: unknown }>;

export interface StoreTokens {
  access: string;
  refresh: string;
}

/** the pasted redirect: appie://login-exit?code=XYZ (or just the code) */
export function extractAhCode(pasted: string): string | null {
  const input = pasted.trim();
  if (!input) return null;
  const fromUrl = /[?&]code=([^&\s]+)/.exec(input);
  if (fromUrl) return decodeURIComponent(fromUrl[1]);
  return /^[\w.-]{8,}$/.test(input) ? input : null;
}

interface AhTokenResponse {
  access_token?: string;
  refresh_token?: string;
}

const toTokens = (json: unknown): StoreTokens | null => {
  const body = json as AhTokenResponse | null;
  return body?.access_token && body.refresh_token ? { access: body.access_token, refresh: body.refresh_token } : null;
};

export async function ahExchangeCode(call: ProxyCall, code: string): Promise<StoreTokens | null> {
  const { status, json } = await call('ah-api', '/mobile-auth/v1/auth/token', {
    method: 'POST',
    body: { clientId: CLIENT_ID, code },
  });
  return status === 200 ? toTokens(json) : null;
}

export async function ahRefresh(call: ProxyCall, refreshToken: string): Promise<StoreTokens | null> {
  const { status, json } = await call('ah-api', '/mobile-auth/v1/auth/token/refresh', {
    method: 'POST',
    body: { clientId: CLIENT_ID, refreshToken },
  });
  return status === 200 ? toTokens(json) : null;
}

export interface AhListResult {
  status: number;
  receipts: AhReceiptSummary[];
}

export async function ahFetchReceipts(call: ProxyCall, accessToken: string): Promise<AhListResult> {
  const { status, json } = await call('ah-api', '/mobile-services/v2/receipts', {
    authorization: `Bearer ${accessToken}`,
  });
  const rows = Array.isArray(json) ? (json as AhReceiptSummary[]) : [];
  return { status, receipts: rows.filter((r) => r.transactionId && r.transactionMoment) };
}

export async function ahFetchReceiptItems(call: ProxyCall, accessToken: string, transactionId: string): Promise<AhReceiptUiItem[]> {
  const { status, json } = await call('ah-api', `/mobile-services/v2/receipts/${encodeURIComponent(transactionId)}`, {
    authorization: `Bearer ${accessToken}`,
  });
  if (status !== 200) return [];
  const detail = json as { receiptUiItems?: AhReceiptUiItem[] } | null;
  return detail?.receiptUiItems ?? [];
}
