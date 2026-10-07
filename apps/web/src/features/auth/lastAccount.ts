/**
 * The account this device signed in with last (user 2026-10-07): Logto
 * carries ONE session per browser and continues it silently, so the app
 * puts the choice in front of the redirect — "Continue as <name>" or
 * "Use another account" — the way the big sign-in pages do. The name only;
 * never a token, never an e-mail address beyond what the person sees.
 */
const KEY = 'munni_last_account';

export interface LastAccount {
  name: string;
  at: number;
}

export function readLastAccount(): LastAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastAccount>;
    return typeof parsed.name === 'string' && parsed.name.trim() ? { name: parsed.name, at: Number(parsed.at) || 0 } : null;
  } catch {
    return null;
  }
}

export function rememberLastAccount(name: string | null | undefined): void {
  try {
    if (!name?.trim()) return;
    localStorage.setItem(KEY, JSON.stringify({ name: name.trim(), at: Date.now() } satisfies LastAccount));
  } catch {
    // storage blocked: the next sign-in simply asks without a name
  }
}

export function forgetLastAccount(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}
