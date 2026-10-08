import { useEffect, useRef } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { readSessionIdentity } from '@/app/session';
import { pullConnections, pushAllConnections, pushConnection, removeConnectionCipher } from './connectionSync';
import { ensureStoreFeed, myStoreFeedId } from './storeFeed';
import { reevaluateSpace } from './receiptMatching';
import { linkedTxIds } from './receiptLinks';
import { logActivity } from './activity';
import { storeConnLinkId } from '@/domain/feedIds';
import { ConnectorError, connectorApi } from '@/features/connectors/api';
import { forgetConnection, keepBundle, readBundle } from '@/features/connectors/bundles';
import { settleQuestion, syncConnection } from '@/features/connectors/connectorSync';
import type { SyncOptions, SyncReport } from '@/features/connectors/connectorSync';
import type { ProviderManifest, SessionView } from '@/features/connectors/types';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow, ConnectorConnRow, ReceiptRow, StoreConnLinkRow, StoreConnRow } from '@/db/types';

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

/** #445: the ids of the connections that still exist — what an account's `connectionId` is read against */
export function useLiveConnectionIds(): ReadonlySet<string> | undefined {
  const { store } = useData();
  return useQuery(
    store,
    async () => new Set((await store.allRows('storeConn')).filter((c) => c.deleted === 0).map((c) => c.id)),
    [],
  );
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

/** a bank account the connector platform fetched, with the spaces it is attached to */
export interface ConnectorAccountView {
  account: AccountRow;
  /** the spaces it is attached to, each with who attached it (whose connection feeds it, 2026-10-08) */
  attachedTo: { spaceId: string; name: string; attachedBy?: string }[];
}

/**
 * Every account a party fetched for this user (M4): the feed rows with
 * `source: 'connector'`, joined with their attachments — the hub lists
 * them under the party's card and offers the attach step for each.
 */
export function useConnectorAccounts(): ConnectorAccountView[] | undefined {
  const { store } = useData();
  return useQuery(
    store,
    async () => {
      const accounts = (await store.allRows('account')).filter((a) => a.deleted === 0 && a.source === 'connector' && !a.archived);
      if (accounts.length === 0) return [];
      const spaces = new Map((await store.allRows('space')).filter((s) => s.deleted === 0).map((s) => [s.id, s.name]));
      const links = (await store.allRows('accountLink')).filter((l) => l.deleted === 0 && !l.archived);
      return accounts
        .map((account) => ({
          account,
          attachedTo: links
            .filter((l) => l.accountId === account.id && spaces.has(l.spaceId))
            .map((l) => ({ spaceId: l.spaceId, name: spaces.get(l.spaceId)!, attachedBy: l.attachedBy })),
        }))
        .sort((a, b) => a.account.name.localeCompare(b.account.name));
    },
    [],
  );
}

/**
/** the connections a space includes (storeConnLink) */
const includedConnections = async (store: StorageBackend, spaceId: string): Promise<Set<string>> =>
  new Set((await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0).map((l) => l.instanceId));

/** the owner's global receipts the space may attach: every receipt of its included connections, newest first */
async function attachableRows(store: StorageBackend, spaceId: string, feedId: string): Promise<ReceiptRow[]> {
  const included = await includedConnections(store, spaceId);
  const rows = (await store.bySpace('receipt', feedId)).filter((r) => r.deleted === 0 && r.instanceId != null && included.has(r.instanceId));
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

/** per global receipt, the transactions its link in the space is attached to (an attached link only) */
async function attachedTxIds(store: StorageBackend, spaceId: string): Promise<Map<string, string[]>> {
  const attachedTo = new Map<string, string[]>();
  for (const link of await store.bySpace('receiptLink', spaceId)) {
    if (link.deleted === 0 && link.receiptId && link.txId) attachedTo.set(link.receiptId, linkedTxIds(link));
  }
  return attachedTo;
}

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
      const linked = await attachedTxIds(store, spaceId);
      return (await attachableRows(store, spaceId, feedId)).filter((r) => !linked.has(r.id));
    },
    [spaceId],
  );
}

/** the picker's inventory (user 2026-10-08: a receipt attached elsewhere is still on offer, and says where it is) */
export interface AttachableReceipts {
  /** every receipt of the included connections, attached or not, newest first */
  rows: ReceiptRow[];
  /** the transactions each receipt is attached to in this space, by receipt id — absent = not attached */
  attachedTo: Map<string, string[]>;
}

/**
 * Owner view: every global receipt the active space may attach — the
 * unmatched ones and the ones already proving a transaction alike
 * (user 2026-10-08: several payments can end up with one receipt, so the
 * picker lists it under each of them and says where it already sits).
 */
export function useAttachableReceipts(): AttachableReceipts | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const feedId = myStoreFeedId();
      if (!feedId) return { rows: [], attachedTo: new Map<string, string[]>() };
      return { rows: await attachableRows(store, spaceId, feedId), attachedTo: await attachedTxIds(store, spaceId) };
    },
    [spaceId],
  );
}

/** every receipt the shops handed over, newest first — the hub's own list, no space in between */
export function useGlobalReceipts(): ReceiptRow[] | undefined {
  const { store } = useData();
  return useQuery(
    store,
    async () => {
      const feedId = myStoreFeedId();
      if (!feedId) return [];
      const rows = (await store.bySpace('receipt', feedId)).filter((r) => r.deleted === 0 && r.instanceId != null);
      rows.sort((a, b) => b.date.localeCompare(a.date));
      return rows;
    },
    [],
  );
}

/** the dates a connection's fetches cover, with how many rows they brought */
export interface FetchedRange {
  count: number;
  /** yyyy-mm-dd, the oldest row */
  from: string;
  /** yyyy-mm-dd, the newest row */
  to: string;
}

const widen = (ranges: Record<string, FetchedRange>, connectionId: string, date: string) => {
  const day = date.slice(0, 10);
  const current = ranges[connectionId];
  if (!current) {
    ranges[connectionId] = { count: 1, from: day, to: day };
    return;
  }
  current.count += 1;
  if (day < current.from) current.from = day;
  if (day > current.to) current.to = day;
};

/**
 * What every connection fetched so far — a shop's receipts by the
 * connection that pulled them, a bank's transactions through the accounts
 * it handed over — so a card can say "from … to …" (user request
 * 2026-10-02). Derived from the rows themselves: always true, never a
 * claim.
 */
/** a shop's receipts, by the connection that pulled them */
async function receiptRanges(store: StorageBackend, ranges: Record<string, FetchedRange>): Promise<void> {
  const feedId = myStoreFeedId();
  if (!feedId) return;
  for (const receipt of await store.bySpace('receipt', feedId)) {
    if (receipt.deleted === 0 && receipt.instanceId) widen(ranges, receipt.instanceId, receipt.date);
  }
}

/** a bank's transactions through the accounts it handed over, credited to every connection of that party */
async function bankRanges(store: StorageBackend, ranges: Record<string, FetchedRange>): Promise<void> {
  const banks = (await store.allRows('storeConn')).filter((c) => c.deleted === 0 && c.kind === 'bank');
  if (banks.length === 0) return;
  const accounts = (await store.allRows('account')).filter((a) => a.deleted === 0 && a.source === 'connector' && a.provider);
  for (const feed of new Set(accounts.map((a) => a.spaceId))) {
    const byAccount = new Map(accounts.filter((a) => a.spaceId === feed).map((a) => [a.id, a.provider]));
    for (const tx of await store.bySpace('transaction', feed)) {
      const provider = tx.deleted === 0 ? byAccount.get(tx.accountId) : undefined;
      if (!provider) continue;
      for (const bank of banks.filter((b) => b.store === provider)) widen(ranges, bank.id, tx.date);
    }
  }
}

export function useFetchedRanges(): Record<string, FetchedRange> | undefined {
  const { store } = useData();
  return useQuery(
    store,
    async () => {
      const ranges: Record<string, FetchedRange> = {};
      await receiptRanges(store, ranges);
      await bankRanges(store, ranges);
      return ranges;
    },
    [],
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
  /** a settled login becomes a connection: rows, custody, the first sync — no space inclusion, that is picked afterwards */
  adopt: (args: AdoptArgs) => Promise<AdoptResult>;
  rename: (connectionId: string, displayName: string) => Promise<void>;
  setIcon: (connectionId: string, icon: string | null) => Promise<void>;
  /** ruling 2: unmatched receipts die with the connection; links survive */
  remove: (connectionId: string) => Promise<void>;
  syncNow: (connectionId: string, options?: Pick<SyncOptions, 'onChallenge' | 'onProgress'>) => Promise<SyncReport>;
  /** per-space inclusion (accountLink analogue); added spaces re-match */
  setIncludedSpaces: (connectionId: string, spaceIds: string[]) => Promise<void>;
  /** #441 L1: the person's answer to "report this failure?" — yes keeps the picture for the people who run munni, no deletes it; either way the question closes */
  answerReport: (connectionId: string, jobId: string, share: boolean) => Promise<void>;
  /** #441 L1: always report this connection's failures without asking */
  setReportFailures: (connectionId: string, always: boolean) => Promise<void>;
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
    // the person's standing answer outlives the session (user 2026-10-07: a
    // re-login wiped it and the question came back); the old error and the
    // old session's job do not — this sign-in settled them
    reportFailures: existing?.reportFailures,
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
        kind: manifest.kind,
        displayName,
        providerAccountHash,
        connectedAt: new Date().toISOString().slice(0, 10),
        status: 'ok',
      });
      // a connection is the person's, not a space's (user ruling 2026-10-02):
      // nothing joins a space by itself — a shop's spaces are picked on the
      // step after naming or from its card, a bank's accounts are attached
      // one by one on the space's accounts screen, like every other feed account
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
    answerReport: async (connectionId, jobId, share) => {
      const row = await storage.connectorConnGet(connectionId);
      const provider = row?.provider ?? (await metaOf(storage, connectionId))?.store;
      if (!provider) return;
      // a question the relay no longer holds has lapsed by itself: nothing to say about that
      await (share ? connectorApi.shareArtifacts(provider, jobId) : connectorApi.declineArtifacts(provider, jobId)).catch(() => undefined);
      await settleQuestion(storage, connectionId, jobId);
    },
    setReportFailures: async (connectionId, always) => {
      const row = await storage.connectorConnGet(connectionId);
      if (row) await storage.connectorConnPut({ ...row, reportFailures: always || undefined });
    },
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
    // a job accepted earlier and never collected is due now, whatever the clock says (prod 2026-10-06)
    if (row.lastSyncAt && !row.pendingJob && Date.now() - Date.parse(row.lastSyncAt) < dueMs) continue;
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
