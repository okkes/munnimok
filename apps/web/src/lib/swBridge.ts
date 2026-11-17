// mirrors app state into the service worker's IDB store: the worker boots cold and cannot read localStorage;
// dependency-free on purpose

function kvPut(key: string, value: unknown): void {
  try {
    const open = indexedDB.open('munni_sw', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('kv');
    open.onsuccess = () => {
      try {
        open.result.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
      } catch {
        // best effort — the worker falls back to doing nothing
      }
    };
  } catch {
    // indexedDB unavailable (some private modes)
  }
}

export function mirrorLangForSw(lang: string): void {
  kvPut('lang', lang);
}

export interface SwSessionMirror {
  apiUrl: string;
  identityKey: string;
  bearer?: string;
  expiresAt?: number;
  testSub?: string;
}

let lastMirrored = '';

// same trust boundary as the tokens in localStorage (documented local-first trade-off);
// deduplicated: the auth path resolves on every request
export function mirrorSessionForSw(session: SwSessionMirror): void {
  const fingerprint = `${session.identityKey}:${session.bearer ?? session.testSub}`;
  if (fingerprint === lastMirrored) return;
  lastMirrored = fingerprint;
  kvPut('session', session);
}

export function clearSwSession(): void {
  lastMirrored = '';
  kvPut('session', undefined);
}

/** JWT exp claim (seconds) → epoch ms; null when unparsable */
export function jwtExpiryMs(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replaceAll('-', '+').replaceAll('_', '/'))) as {
      exp?: number;
    };
    return payload.exp ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}
