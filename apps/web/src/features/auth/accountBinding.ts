import { apiFetch } from '@/lib/api';
import type { Identity } from '@/app/session';

// remote-wipe: an account deleted elsewhere gets a FRESH user row (new id) on the next request, so a /me userId
// differing from the bound one means this device's copy is dead. Offline, errors and even 404s verify nothing:
// a gateway hiccup must never wipe a device
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
  if (!res?.ok) return;
  const me = (await res.json().catch(() => null)) as { userId?: string } | null;
  if (!me?.userId) return;
  const bound = (await store.metaGet(BOUND_USER_KEY))?.value as string | undefined;
  if (!bound) {
    await store.metaPut(BOUND_USER_KEY, me.userId);
    return;
  }
  if (bound !== me.userId) await onDead();
}
