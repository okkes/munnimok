import { useEffect, useRef } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { readSessionIdentity } from '@/app/session';
import { apiFetch } from '@/lib/api';
import { ahExchangeCode, extractAhCode } from '@/features/shopping/stores/ah';
import type { ProxyCall } from '@/features/shopping/stores/ah';
import { jumboLogin } from '@/features/shopping/stores/jumbo';
import { syncAhReceipts, syncJumboReceipts } from '@/features/shopping/stores/sync';
import type { StoreSyncResult } from '@/features/shopping/stores/sync';
import type { ReceiptRow, StoreConnectionRow, StoreMarkerRow } from '@/db/types';

/** the real proxy binding — every store call rides the api pass-through */
const proxyCall: ProxyCall = async (store, path, init = {}) => {
  const response = await apiFetch(`/shop/proxy/${store}`, {
    method: 'POST',
    body: JSON.stringify({
      path,
      method: init.method ?? 'GET',
      body: init.body,
      authorization: init.authorization,
      userAgent: init.userAgent,
    }),
  });
  const json = await response.json().catch(() => null);
  // jumbo hands its session token back in a relayed response header
  const jumboToken = response.headers.get('x-jumbo-token') ?? undefined;
  return { status: response.status, json, headers: jumboToken ? { jumboToken } : undefined };
};

/** store connections are a signed-in-user feature: demo/offline make zero network calls */
export const storesAvailable = (): boolean => readSessionIdentity()?.kind === 'user';

export function useStoreConnections(): StoreConnectionRow[] | undefined {
  const { store } = useData();
  return useQuery(store, async () => store.storeConnAll(), []);
}

export function useStoreMarkers(): StoreMarkerRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => (await store.bySpace('storeMarker', spaceId)).filter((m) => m.deleted === 0),
    [spaceId],
  );
}

/** receipts that arrived without an unambiguous transaction match */
export function useUnmatchedReceipts(): ReceiptRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const rows = (await store.bySpace('receipt', spaceId)).filter((r) => r.deleted === 0 && !r.txId);
      rows.sort((a, b) => b.date.localeCompare(a.date));
      return rows;
    },
    [spaceId],
  );
}

export type ConnectableStore = 'ah' | 'jumbo';

export interface StoreOps {
  /** paste-the-redirect connect flow; resolves false when the code is bad */
  connectAh: (pasted: string) => Promise<boolean>;
  /** username/password login — credentials are exchanged, never stored */
  connectJumbo: (username: string, password: string) => Promise<'ok' | 'blocked' | 'failed'>;
  disconnect: (store: ConnectableStore) => Promise<void>;
  syncNow: (store: ConnectableStore) => Promise<StoreSyncResult>;
  attachReceipt: (receiptId: string, txId: string) => Promise<void>;
  /** which spaces this connection's receipts flow into (user ruling) */
  setSharedSpaces: (store: ConnectableStore, spaceIds: string[]) => Promise<void>;
}

export function useStoreOps(): StoreOps {
  const { store: storage, repo, spaceId } = useData();
  return {
    connectAh: async (pasted) => {
      const code = extractAhCode(pasted);
      if (!code) return false;
      const tokens = await ahExchangeCode(proxyCall, code);
      if (!tokens) return false;
      await storage.storeConnPut({
        store: 'ah',
        tokens: { access: tokens.access, refresh: tokens.refresh },
        refreshedAt: new Date().toISOString(),
        status: 'ok',
        sharedSpaceIds: [spaceId], // starts private to the connecting space
      });
      await repo.upsert('storeMarker', spaceId, `store:${spaceId}:ah`, {
        store: 'ah',
        status: 'connected',
        connectedAt: new Date().toISOString().slice(0, 10),
      });
      void syncAhReceipts(proxyCall, storage, repo, spaceId);
      return true;
    },
    disconnect: async (store) => {
      const connection = await storage.storeConnGet(store);
      await storage.storeConnDelete(store);
      for (const shared of connection?.sharedSpaceIds ?? [spaceId]) {
        await repo.remove('storeMarker', shared, `store:${shared}:${store}`);
      }
    },
    connectJumbo: async (username, password) => {
      const login = await jumboLogin(proxyCall, username, password);
      if (!login.token) return login.outcome;
      await storage.storeConnPut({
        store: 'jumbo',
        tokens: { token: login.token },
        refreshedAt: new Date().toISOString(),
        status: 'ok',
        sharedSpaceIds: [spaceId], // starts private to the connecting space
      });
      await repo.upsert('storeMarker', spaceId, `store:${spaceId}:jumbo`, {
        store: 'jumbo',
        status: 'connected',
        connectedAt: new Date().toISOString().slice(0, 10),
      });
      void syncJumboReceipts(proxyCall, storage, repo, spaceId);
      return 'ok';
    },
    syncNow: (store) =>
      store === 'jumbo'
        ? syncJumboReceipts(proxyCall, storage, repo, spaceId)
        : syncAhReceipts(proxyCall, storage, repo, spaceId),
    attachReceipt: async (receiptId, txId) => {
      await repo.upsert('receipt', spaceId, receiptId, { txId });
    },
    setSharedSpaces: async (store, spaceIds) => {
      const connection = await storage.storeConnGet(store);
      if (!connection) return;
      const before = new Set(connection.sharedSpaceIds ?? [spaceId]);
      await storage.storeConnPut({ ...connection, sharedSpaceIds: spaceIds });
      // markers keep every member's device honest about the connection
      for (const id of spaceIds.filter((id) => !before.has(id))) {
        await repo.upsert('storeMarker', id, `store:${id}:${store}`, {
          store,
          status: 'connected',
          connectedAt: new Date().toISOString().slice(0, 10),
        });
      }
      for (const id of [...before].filter((id) => !spaceIds.includes(id))) {
        await repo.remove('storeMarker', id, `store:${id}:${store}`);
      }
      // newly shared spaces receive the backlog right away
      const sync = store === 'jumbo' ? syncJumboReceipts : syncAhReceipts;
      void sync(proxyCall, storage, repo, spaceId).catch(() => undefined);
    },
  };
}

const KEEP_ALIVE_MS = 12 * 60 * 60 * 1000;

/**
 * Headless: once per app open (signed-in users, online), refresh store
 * tokens opportunistically and pull new receipts — the keep-alive the
 * design promises so connections don't silently rot.
 */
export function useStoreKeepAlive(): void {
  const { store: storage, repo, spaceId } = useData();
  const ran = useRef(false);
  useEffect(() => {
    if (ran.current || !storesAvailable() || !navigator.onLine) return;
    ran.current = true;
    void (async () => {
      for (const store of ['ah', 'jumbo'] as const) {
        const connection = await storage.storeConnGet(store);
        if (connection?.status !== 'ok') continue;
        if (Date.now() - Date.parse(connection.refreshedAt) < KEEP_ALIVE_MS) continue;
        const sync = store === 'jumbo' ? syncJumboReceipts : syncAhReceipts;
        await sync(proxyCall, storage, repo, spaceId);
      }
    })().catch(() => undefined); // best-effort: a closed db or offline hop must not throw
  }, [storage, repo, spaceId]);
}
