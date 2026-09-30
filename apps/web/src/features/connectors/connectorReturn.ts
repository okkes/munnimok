/**
 * The bank's return (§15). A party that sends the person to a page and
 * comes back to the app's own return page (`/gc-callback`) does so in a
 * fresh document — the same tab on the web, the app re-entered through
 * its App Link on a phone — so what the return page needs to answer the
 * challenge is written down before the page opens: which session, which
 * challenge, and the code the party will put in the query. localStorage,
 * because the document that reads it is not the one that wrote it.
 */
export interface PendingReturn {
  provider: string;
  sessionId: string;
  challengeId: string;
  /** the reference the party echoes (`ref` for GoCardless, `state` for Enable Banking) */
  code: string;
  connectionId: string;
  reconnect: boolean;
  /** an existing connection's label, kept so the adoption names it the same */
  at: string;
}

const KEY = 'munni_connector_return';

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function rememberReturn(pending: Omit<PendingReturn, 'at'>): void {
  storage()?.setItem(KEY, JSON.stringify({ ...pending, at: new Date().toISOString() }));
}

/** the pending return whose code the query names — or the only one, when the query names none */
export function pendingReturnFor(code: string | null): PendingReturn | null {
  const raw = storage()?.getItem(KEY);
  if (!raw) return null;
  try {
    const pending = JSON.parse(raw) as PendingReturn;
    if (!pending.sessionId || !pending.challengeId) return null;
    return code && pending.code !== code ? null : pending;
  } catch {
    return null;
  }
}

export function forgetReturn(): void {
  storage()?.removeItem(KEY);
}

/** the reference a bank's return carries: GoCardless echoes `ref`, Enable Banking the `state` it was given */
export const returnCodeOf = (params: URLSearchParams): string | null => params.get('ref') ?? params.get('state');
