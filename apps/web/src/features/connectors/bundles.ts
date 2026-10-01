import type { StorageBackend } from '@/db/backend';
import { isNativeApp } from '@/lib/platform';

/**
 * Custody of a connection's credential bundle (docs/connector-integration-plan.md
 * §10.3): on the phone it rests in the encrypted store's device-only
 * row; on the web it lives in sessionStorage and dies with the tab —
 * the row stays, the connection reads "sign in to sync" next time. The
 * bundle is never synced through spaces and never exported.
 */

export type Custody = 'device' | 'ephemeral';

export const custodyHere = (): Custody => (isNativeApp() ? 'device' : 'ephemeral');

const key = (connectionId: string): string => `munni_connector_bundle:${connectionId}`;

function sessionRead(connectionId: string): string | undefined {
  try {
    return sessionStorage.getItem(key(connectionId)) ?? undefined;
  } catch {
    return undefined; // a private window with storage blocked: no custody at all
  }
}

function sessionWrite(connectionId: string, bundle: string | null): void {
  try {
    if (bundle === null) sessionStorage.removeItem(key(connectionId));
    else sessionStorage.setItem(key(connectionId), bundle);
  } catch {
    // nothing to do: the next sync asks for a sign-in
  }
}

/** a bundle in the row means device custody, wherever the row was written; the tab's copy otherwise */
export async function readBundle(store: StorageBackend, connectionId: string): Promise<string | undefined> {
  const row = await store.connectorConnGet(connectionId);
  return row?.bundle ?? sessionRead(connectionId);
}

/** keep a bundle that just changed hands; the row's `refreshedAt` moves with it */
export async function keepBundle(store: StorageBackend, connectionId: string, bundle: string): Promise<void> {
  const row = await store.connectorConnGet(connectionId);
  if (!row) return;
  const refreshedAt = new Date().toISOString();
  if (custodyHere() === 'ephemeral') {
    sessionWrite(connectionId, bundle);
    await store.connectorConnPut({ ...row, bundle: undefined, refreshedAt });
    return;
  }
  await store.connectorConnPut({ ...row, bundle, refreshedAt });
}

export async function dropBundle(store: StorageBackend, connectionId: string): Promise<void> {
  sessionWrite(connectionId, null);
  const row = await store.connectorConnGet(connectionId);
  if (row?.bundle) await store.connectorConnPut({ ...row, bundle: undefined });
}

/** every trace of the connection on this device */
export async function forgetConnection(store: StorageBackend, connectionId: string): Promise<void> {
  sessionWrite(connectionId, null);
  await store.connectorConnDelete(connectionId);
}
