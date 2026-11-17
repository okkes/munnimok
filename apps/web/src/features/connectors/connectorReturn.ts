// a party that returns to /gc-callback does so in a fresh document, so what the return page needs is written to
// localStorage before the page opens: the document that reads it is not the one that wrote it
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

export const returnCodeOf = (params: URLSearchParams): string | null => params.get('ref') ?? params.get('state');
