// Logto continues ONE session per browser; once it is gone a plain sign-in lands on Logto's empty page (#559), so the way in
// is remembered with the name: a social account goes straight to its provider, a username account gets it filled in
// an unknown way in offers the plain "Sign in"; never a token, a password or an e-mail address is stored
const KEY = 'munni_last_account';
const SOCIAL_TARGET = /^[a-z0-9-]{1,40}$/;

export interface LastAccount {
  name: string;
  at: number;
  /** a social-only account's connector (Logto's direct sign-in target: google, apple, …) */
  social?: string;
  username?: string;
}

export type SignInWay = Pick<LastAccount, 'social' | 'username'>;

export function readLastAccount(): LastAccount | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<LastAccount>;
    if (typeof parsed.name !== 'string' || !parsed.name.trim()) return null;
    return {
      name: parsed.name,
      at: Number(parsed.at) || 0,
      ...(typeof parsed.social === 'string' && SOCIAL_TARGET.test(parsed.social) ? { social: parsed.social } : {}),
      ...(typeof parsed.username === 'string' && parsed.username.trim() ? { username: parsed.username.trim() } : {}),
    };
  } catch {
    return null;
  }
}

export function rememberLastAccount(name: string | null | undefined, way: SignInWay = {}): void {
  try {
    if (!name?.trim()) {
      // nothing to show for this account: the previous person's record must not stand in for it
      localStorage.removeItem(KEY);
      return;
    }
    localStorage.setItem(KEY, JSON.stringify({ name: name.trim(), at: Date.now(), ...way } satisfies LastAccount));
  } catch {
    // storage blocked: the next sign-in simply asks without a name
  }
}

// several social identities and no username stay unknown: guessing would send the person to the wrong provider
export function signInWayOf(info: { username?: string | null; identities?: Record<string, unknown> | null }): SignInWay {
  const socials = Object.keys(info.identities ?? {}).filter((target) => SOCIAL_TARGET.test(target));
  if (socials.length === 1) return { social: socials[0] };
  return info.username?.trim() ? { username: info.username.trim() } : {};
}

// best-effort, capped at 3 s; the token is the one the code exchange just minted (no refresh race) and the call is our own,
// so a failure never lands in the SDK's shared error that the callback screen reports
export async function readSignInWay(
  endpoint: string,
  username: string | null | undefined,
  getToken: (() => Promise<string | null | undefined>) | undefined,
): Promise<SignInWay> {
  const identities = async (): Promise<Record<string, unknown> | undefined> => {
    const token = await getToken?.();
    if (!token) return undefined;
    const base = endpoint.endsWith('/') ? endpoint : `${endpoint}/`;
    const res = await fetch(new URL('oidc/me', base), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return undefined;
    return ((await res.json()) as { identities?: Record<string, unknown> }).identities;
  };
  const lookup = identities().catch(() => undefined);
  const found = await Promise.race([
    lookup,
    new Promise<undefined>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      void lookup.finally(() => clearTimeout(timer));
    }),
  ]);
  return signInWayOf({ username, identities: found });
}

/** what "Continue as" adds to the sign-in: straight to the provider, or the username filled in; null when unknown */
export function continueOptions(
  last: LastAccount | null,
): { directSignIn: { method: 'social'; target: string } } | { loginHint: string } | null {
  if (last?.social) return { directSignIn: { method: 'social', target: last.social } };
  if (last?.username) return { loginHint: last.username };
  return null;
}

export function forgetLastAccount(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to forget
  }
}
