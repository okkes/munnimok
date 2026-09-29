import { useEffect, useRef } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { readSessionIdentity } from '@/app/session';
import { pullConnections, pushAllConnections, pushConnection, removeConnectionCipher } from './connectionSync';
import { ensureStoreFeed, myStoreFeedId } from './storeFeed';
import { reevaluateSpace } from './receiptMatching';
import { logActivity } from './activity';
import { storeConnLinkId } from '@/domain/feedIds';
import { ConnectorError, connectorApi } from '@/features/connectors/api';
import { forgetConnection, keepBundle, readBundle } from '@/features/connectors/bundles';
import { syncConnection } from '@/features/connectors/connectorSync';
import type { SyncOptions, SyncReport } from '@/features/connectors/connectorSync';
import type { ProviderManifest, SessionView } from '@/features/connectors/types';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { ConnectorConnRow, ReceiptRow, StoreConnLinkRow, StoreConnRow } from '@/db/types';

/**
 * Connections (#367, the hub): a connection is a synced, secret-free
 * `storeConn` row in the owner's store feed (name, icon, provider — every
 * device renders it), a per-space `storeConnLink` for each space its
 * receipts flow into, and a DEVICE-ONLY `connectorConn` row holding the
 * bundle the party handed this device. The relay keys every receipt by
 * the connection id, so the id outlives re-logins and the receipts stay
 * one row each.
 */

/** connections are a signed-in-user feature: demo/offline make zero network calls */
export const connectorsAvailable = (): boolean => readSessionIdentity()?.kind === 'user';

/** what the hub renders per connection */
export interface ConnectionView {
  meta: StoreConnRow;
  /** this device's row — absent when the connection was made elsewhere */
  device?: ConnectorConnRow;
  /** this device can sync it right now */
  hasBundle: boolean;
}

/** device-local rows (bundle custody, last relay state) */
export function useConnectorConns(): ConnectorConnRow[] | undefined {
  const { store } = useData();
  return useQuery(store, async () => store.connectorConnAll(), []);
}

/** synced connection METADATA — every device of the owner renders these */
export function useStoreConnMetas(): StoreConnRow[] | undefined {
  const { store } = useData();
  return useQuery(store, async () => (await store.allRows('storeConn')).filter((c) => c.deleted === 0), []);
}

/** connections included in the ACTIVE space (members see these) */
export function useSpaceStoreConnLinks(): StoreConnLinkRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => (await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0),
    [spaceId],
  );
}

/** the hub's list: metadata joined with this device's state, by name */
export function useConnections(): ConnectionView[] | undefined {
  const { store } = useData();
  return useQuery(
    store,
    async () => {
      const metas = (await store.allRows('storeConn')).filter((c) => c.deleted === 0);
      const devices = new Map((await store.connectorConnAll()).map((d) => [d.id, d]));
      const views: ConnectionView[] = [];
      for (const meta of metas) {
        views.push({ meta, device: devices.get(meta.id), hasBundle: !!(await readBundle(store, meta.id)) });
      }
      return views.sort((a, b) => a.meta.displayName.localeCompare(b.meta.displayName));
    },
    [],
  );
}

/**
 * Owner view: global receipts of connections included in the active
 * space that are not yet linked into it — the manual-attach inventory.
 */
export function useUnmatchedReceipts(): ReceiptRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const feedId = myStoreFeedId();
      if (!feedId) return [];
      const included = new Set(
        (await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0).map((l) => l.instanceId),
      );
      const linked = new Set(
        (await store.bySpace('receiptLink', spaceId))
          .filter((l) => l.deleted === 0 && l.receiptId && l.txId)
          .map((l) => l.receiptId!),
      );
      const rows = (await store.bySpace('receipt', feedId)).filter(
        (r) => r.deleted === 0 && r.instanceId != null && included.has(r.instanceId) && !linked.has(r.id),
      );
      rows.sort((a, b) => b.date.localeCompare(a.date));
      return rows;
    },
    [spaceId],
  );
}

export interface AdoptArgs {
  manifest: ProviderManifest;
  /** the settled session view — its bundle is kept, its account tells duplicates */
  view: SessionView;
  connectionId: string;
  /** the login refreshed an existing connection */
  reconnect: boolean;
  label?: string;
}

export interface AdoptResult {
  connectionId: string;
  /** an existing connection looks like the SAME party account (warning) */
  duplicateOf?: string;
}

export interface ConnectionOps {
  /** a settled login becomes a connection: rows, custody, inclusion, the first sync */
  adopt: (args: AdoptArgs) => Promise<AdoptResult>;
  rename: (connectionId: string, displayName: string) => Promise<void>;
  setIcon: (connectionId: string, icon: string | null) => Promise<void>;
  /** ruling 2: unmatched receipts die with the connection; links survive */
  remove: (connectionId: string) => Promise<void>;
  syncNow: (connectionId: string, options?: Pick<SyncOptions, 'onChallenge' | 'onProgress'>) => Promise<SyncReport>;
  /** per-space inclusion (accountLink analogue); added spaces re-match */
  setIncludedSpaces: (connectionId: string, spaceIds: string[]) => Promise<void>;
}

const hashIdentity = async (provider: string, identity: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${provider}:${identity}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** default display name: the party's name, numbered when it exists already */
const defaultName = (metas: readonly StoreConnRow[], base: string): string => {
  const taken = new Set(metas.filter((m) => m.deleted === 0).map((m) => m.displayName));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
};

const metaOf = async (storage: StorageBackend, connectionId: string): Promise<StoreConnRow | undefined> =>
  (await storage.allRows('storeConn')).find((c) => c.id === connectionId && c.deleted === 0);

/** the device row after a login: custody first, the bundle right behind it */
async function keepDeviceRow(storage: StorageBackend, connectionId: string, provider: string, view: SessionView): Promise<void> {
  const existing = await storage.connectorConnGet(connectionId);
  await storage.connectorConnPut({
    id: connectionId,
    provider,
    credentialBundle: view.credentialBundle ?? existing?.credentialBundle,
    sessionId: view.sessionId,
    state: view.state,
    refreshedAt: new Date().toISOString(),
    lastSyncAt: existing?.lastSyncAt,
  });
  if (view.bundle) await keepBundle(storage, connectionId, view.bundle);
}

export function useConnectionOps(): ConnectionOps {
  const { store: storage, repo, spaceId, engine } = useData();

  const allLinksOf = async (connectionId: string) =>
    (await storage.allRows('storeConnLink')).filter((l) => l.deleted === 0 && l.instanceId === connectionId);

  const firstSync = (connectionId: string) => {
    void syncConnection(storage, repo, connectionId, { engine }).catch(() => undefined);
  };

  return {
    adopt: async ({ manifest, view, connectionId, reconnect, label }) => {
      await keepDeviceRow(storage, connectionId, manifest.id, view);
      void pushConnection(storage, connectionId).catch(() => undefined);
      if (reconnect) {
        const meta = await metaOf(storage, connectionId);
        if (meta) await repo.upsert('storeConn', meta.spaceId, connectionId, { status: 'ok' });
        firstSync(connectionId);
        return { connectionId };
      }
      const feedId = await ensureStoreFeed(storage);
      if (!feedId) throw new Error('the store feed could not be registered');
      const metas = (await storage.allRows('storeConn')).filter((c) => c.deleted === 0);
      const externalId = view.providerAccount?.externalId;
      const providerAccountHash = externalId ? await hashIdentity(manifest.id, externalId) : undefined;
      const duplicateOf = providerAccountHash
        ? metas.find((m) => m.store === manifest.id && m.providerAccountHash === providerAccountHash)?.id
        : undefined;
      const displayName = label?.trim() || defaultName(metas, manifest.name);
      await repo.upsert('storeConn', feedId, connectionId, {
        store: manifest.id,
        displayName,
        providerAccountHash,
        connectedAt: new Date().toISOString().slice(0, 10),
        status: 'ok',
      });
      // starts included in the connecting space (v2 behavior, user ruling)
      await repo.upsert('storeConnLink', spaceId, storeConnLinkId(spaceId, connectionId), {
        instanceId: connectionId,
        store: manifest.id,
        displayName,
      });
      void logActivity(storage, repo, spaceId, 'storeConnect', displayName);
      firstSync(connectionId);
      return { connectionId, duplicateOf };
    },
    rename: async (connectionId, displayName) => {
      const meta = await metaOf(storage, connectionId);
      if (!meta || !displayName.trim()) return;
      await repo.upsert('storeConn', meta.spaceId, connectionId, { displayName: displayName.trim() });
      // members render the snapshot on the link rows — keep them current
      for (const link of await allLinksOf(connectionId)) {
        await repo.upsert('storeConnLink', link.spaceId, link.id, { displayName: displayName.trim() });
      }
      void logActivity(storage, repo, spaceId, 'storeEdit', displayName.trim());
    },
    setIcon: async (connectionId, icon) => {
      const meta = await metaOf(storage, connectionId);
      if (!meta) return;
      await repo.upsert('storeConn', meta.spaceId, connectionId, { icon: icon ?? (null as never) });
      for (const link of await allLinksOf(connectionId)) {
        await repo.upsert('storeConnLink', link.spaceId, link.id, { icon: icon ?? (null as never) });
      }
      void logActivity(storage, repo, spaceId, 'storeEdit', meta.displayName);
    },
    remove: async (connectionId) => {
      // the party is told first, with the bundle when this device holds
      // it; the relay removes its binding either way
      const device = await storage.connectorConnGet(connectionId);
      if (device?.sessionId) {
        const bundle = await readBundle(storage, connectionId);
        await connectorApi.disconnect(device.provider, device.sessionId, bundle).catch((err: unknown) => {
          if (!(err instanceof ConnectorError)) throw err;
        });
      }
      // ruling 2: the connection's global receipts die with it — space
      // snapshots (linked receipts) live on untouched
      const meta = await metaOf(storage, connectionId);
      if (meta) {
        for (const receipt of await storage.bySpace('receipt', meta.spaceId)) {
          if (receipt.deleted === 0 && receipt.instanceId === connectionId) {
            await repo.remove('receipt', meta.spaceId, receipt.id);
          }
        }
        await repo.remove('storeConn', meta.spaceId, connectionId);
      }
      for (const link of await allLinksOf(connectionId)) {
        await repo.remove('storeConnLink', link.spaceId, link.id);
      }
      await forgetConnection(storage, connectionId);
      void removeConnectionCipher(storage, connectionId).catch(() => undefined);
      void logActivity(storage, repo, spaceId, 'storeRemove', meta?.displayName);
    },
    syncNow: (connectionId, options) => syncConnection(storage, repo, connectionId, { engine, ...options }),
    setIncludedSpaces: async (connectionId, spaceIds) => {
      const meta = await metaOf(storage, connectionId);
      if (!meta) return;
      const current = await allLinksOf(connectionId);
      const currentIds = new Set(current.map((l) => l.spaceId));
      for (const id of spaceIds.filter((id) => !currentIds.has(id))) {
        await repo.upsert('storeConnLink', id, storeConnLinkId(id, connectionId), {
          instanceId: connectionId,
          store: meta.store,
          displayName: meta.displayName,
          icon: meta.icon,
        });
        // R5: a space gaining a connection re-evaluates its transactions
        await reevaluateSpace(storage, repo, id, connectionId);
        // the history line lands in the space that GAINED the connection
        void logActivity(storage, repo, id, 'storeAttach', meta.displayName);
      }
      for (const link of current.filter((l) => !spaceIds.includes(l.spaceId))) {
        await repo.remove('storeConnLink', link.spaceId, link.id);
        void logActivity(storage, repo, link.spaceId, 'storeDetach', meta.displayName);
      }
    },
  };
}

const KEEP_ALIVE_MS = 12 * 60 * 60 * 1000;
/** post-bank-sync receipt pull, at most once per connection per interval (R4) */
const AUTO_SYNC_MS = 15 * 60 * 1000;

async function syncDue(storage: StorageBackend, repo: Repo, dueMs: number, options: SyncOptions): Promise<void> {
  for (const row of await storage.connectorConnAll()) {
    if (row.state !== 'active') continue;
    if (row.lastSyncAt && Date.now() - Date.parse(row.lastSyncAt) < dueMs) continue;
    if (!(await readBundle(storage, row.id))) continue;
    await syncConnection(storage, repo, row.id, options).catch(() => undefined);
  }
}

/**
 * Headless (R4): receipts follow the bank. Once per app open the
 * keep-alive adopts fresher bundles from siblings and pulls; afterwards
 * every successful sync cycle (fresh bank transactions just landed)
 * re-pulls due connections so new receipts arrive next to their
 * transactions. A question a party asks meanwhile waits for the hub.
 */
export function useConnectionKeepAlive(): void {
  const { store: storage, repo, engine } = useData();
  const ran = useRef(false);
  const lastAuto = useRef(0);

  useEffect(() => {
    if (ran.current || !connectorsAvailable() || !navigator.onLine) return;
    ran.current = true;
    void (async () => {
      // E2EE sync (opt-in): adopt fresher bundles from siblings first,
      // publish whatever this device rotated afterwards
      await pullConnections(storage).catch(() => undefined);
      await syncDue(storage, repo, KEEP_ALIVE_MS, { engine });
      await pushAllConnections(storage).catch(() => undefined);
    })().catch(() => undefined); // best-effort: a closed db or offline hop must not throw
  }, [storage, repo, engine]);

  useEffect(() => {
    if (!engine || !connectorsAvailable()) return;
    return engine.onStatus((status) => {
      // 'idle' = a sync cycle just finished cleanly (fresh bank txs in)
      if (status !== 'idle') return;
      if (Date.now() - lastAuto.current < AUTO_SYNC_MS) return;
      lastAuto.current = Date.now();
      void syncDue(storage, repo, AUTO_SYNC_MS, { engine }).catch(() => undefined);
    });
  }, [engine, storage, repo]);
}
