/**
 * Nuke the Logto SDK's persisted state (sign-in session, id/refresh
 * tokens). After a password change on ANOTHER device the stored refresh
 * token is dead and the half-finished sign-in session poisons every
 * retry ("Grant request is invalid" loop) — the user had to delete the
 * app + browser cache by hand. Clearing makes the next attempt a
 * genuinely fresh sign-in instead.
 */
export function clearStaleLogtoState(): void {
  for (const store of [localStorage, sessionStorage]) {
    for (const key of Object.keys(store)) {
      if (key.startsWith('logto:')) store.removeItem(key);
    }
  }
}
