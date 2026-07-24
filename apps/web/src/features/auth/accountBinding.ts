import { apiFetch } from '@/lib/api';
import type { Identity } from '@/app/session';

/**
 * Remote-wipe detection: when an account is deleted (full deletion or a
 * go-offline conversion on ANOTHER device), this device's local copy
 * belongs to a dead account. The server JIT-provisions a FRESH user row
 * (new id) for the same login on the next request, so the device can
 * detect death by comparing the /me userId against the one it bound to
 * at first sync — a mismatch (or an authenticated 404) means "your
 * account is gone": wipe local data and return to the login screen.
 * Offline and transient failures verify nothing — the check only ever
 * acts on a POSITIVE signal.
 */
export const BOUND_USER_KEY = 'boundUserId';

interface MetaStore {
  metaGet(key: string): Promise<{ key: string; value: unknown } | undefined>;
  metaPut(key: string, value: unknown): Promise<void>;
}

export async function verifyAccountBinding(
  store: MetaStore,
  identity: Identity,
  onDead: () => Promise<void>,
): Promise<void> {
  if (identity.kind !== 'user') return;
  const res = await apiFetch('/me').catch(() => null);
  if (!res) return; // offline — nothing to verify
  if (res.status === 404) {
    await onDead();
    return;
  }
  if (!res.ok) return;
  const me = (await res.json().catch(() => null)) as { userId?: string } | null;
  if (!me?.userId) return;
  const bound = (await store.metaGet(BOUND_USER_KEY))?.value as string | undefined;
  if (!bound) {
    await store.metaPut(BOUND_USER_KEY, me.userId);
    return;
  }
  if (bound !== me.userId) await onDead();
}
