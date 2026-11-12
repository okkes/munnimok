/**
 * The account this device signed in with last (user 2026-10-07): Logto
 * carries ONE session per browser and continues it silently, so the app
 * puts the choice in front of the redirect — "Continue as <name>" or
 * "Use another account" — the way the big sign-in pages do.
 *
 * #559: once that session is gone (a sign-out ends it on purpose) a plain
 * sign-in landed on Logto's empty page. So the way the account signs in is
 * remembered with the name: a social-only account goes straight to its
 * provider (Logto's direct sign-in — Google's own session then continues
 * in one tap), a username account finds its username filled in. When the
 * way in is unknown the screen offers the plain "Sign in" instead of a
 * name it cannot keep its promise for. Never a token, a password or an
 * e-mail address.
 */
const KEY = 'munni_last_account';
const SOCIAL_TARGET = /^[a-z0-9-]{1,40}$/;

export interface LastAccount {
  name: string;
  at: number;
  /** a social-only account's connector (Logto's direct sign-in target: google, apple, …) */
  social?: string;
  /** a username account's username — Logto's page fills it in */
  username?: string;
}

/** how the account gets back in, as remembered at its last sign-in */
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

/**
 * The way in, read off Logto's userinfo: the account's one social
 * connector (the quickest way back — the provider's own session usually
 * answers in a tap), else its username. Several social identities and no
 * username stay unknown — guessing one would hand the person to the wrong
 * provider.
 */
export function signInWayOf(info: { username?: string | null; identities?: Record<string, unknown> | null }): SignInWay {
  const socials = Object.keys(info.identities ?? {}).filter((target) => SOCIAL_TARGET.test(target));
  if (socials.length === 1) return { social: socials[0] };
  return info.username?.trim() ? { username: info.username.trim() } : {};
}

/**
 * The way in, asked of Logto's userinfo endpoint (the `identities` scope)
 * right after a sign-in. Best-effort and capped at 3 s: the token is the
 * one the code exchange just minted (no refresh, so no rotation race), the
 * call is our own (a failure never lands in the SDK's shared error, which
 * the callback screen reports), and a slow or failed answer only leaves the
 * social side unknown.
 */
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
