const KEY = 'munni_after_login';
// only an invitation is worth a detour after the sign-in: every other path lands on Home as before
const WORTH = /^\/splits\/join\/[\w-]+$/;

/** an invitation opened while signed out: kept for this tab, across the sign-in's redirects */
export function rememberAfterLogin(path: string): void {
  if (!WORTH.test(path)) return;
  try {
    sessionStorage.setItem(KEY, path);
  } catch {
    // no session storage (a private window): the person opens the link again after signing in
  }
}

/** where the sign-in should land instead of Home — handed out once */
export function takeAfterLogin(): string | null {
  try {
    const path = sessionStorage.getItem(KEY);
    sessionStorage.removeItem(KEY);
    return path && WORTH.test(path) ? path : null;
  } catch {
    return null;
  }
}
