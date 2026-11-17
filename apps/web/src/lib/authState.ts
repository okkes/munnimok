// wipes the Logto SDK's persisted state: after a password change on ANOTHER device the refresh token is dead and the
// half-finished sign-in session poisons every retry ("Grant request is invalid" loop)
// every wipe leaves a breadcrumb (who + when) so the Diagnose report can tell "keys removed" from "keys never written"
export const LOGTO_WIPE_KEY = 'munni_last_logto_wipe';

export function clearStaleLogtoState(reason: string): void {
  for (const store of [localStorage, sessionStorage]) {
    for (const key of Object.keys(store)) {
      if (key.startsWith('logto:')) store.removeItem(key);
    }
  }
  try {
    localStorage.setItem(LOGTO_WIPE_KEY, JSON.stringify({ reason, ts: new Date().toISOString() }));
  } catch {
    // breadcrumb is best-effort — never let it break the wipe itself
  }
}
