import { useEffect, useRef } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { readSessionIdentity } from '@/app/session';
import { pullConnections, pushAllConnections, pushConnection, removeConnectionCipher } from './connectionSync';
import { ensureStoreFeed, myStoreFeedId } from './storeFeed';
import { reevaluateSpace, useReceiptMatchTriggers } from './receiptMatching';
import { linkedTxIds } from './receiptLinks';
import { logActivity } from './activity';
import { storeConnLinkId } from '@/domain/feedIds';
import { ConnectorError, connectorApi } from '@/features/connectors/api';
import { forgetConnection, keepBundle, readBundle } from '@/features/connectors/bundles';
import { settleQuestion, syncConnection } from '@/features/connectors/connectorSync';
import type { SyncOptions, SyncReport } from '@/features/connectors/connectorSync';
import type { BindingView, ProviderManifest, SessionView } from '@/features/connectors/types';
import { fetchMyFeedIds } from '@/features/accounts/feedGateway';
import type { Repo } from '@/db/repo';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow, ConnectorConnRow, ReceiptRow, StoreConnLinkRow, StoreConnRow } from '@/db/types';

// storeConn (synced, secret-free) + per-space storeConnLink + a DEVICE-ONLY connectorConn row holding the bundle;
// the relay keys receipts by connection id, so the id outlives re-logins (#367)

/** connections are a signed-in-user feature: demo/offline make zero network calls */
export const connectorsAvailable = (): boolean => readSessionIdentity()?.kind === 'user';

export interface ConnectionView {
  meta: StoreConnRow;
  /** this device's row — absent when the connection was made elsewhere */
  device?: ConnectorConnRow;
  hasBundle: boolean;
}

export function useConnectorConns(): ConnectorConnRow[] | undefined {
  const { store } = useData();
  return useQuery(store, async () => store.connectorConnAll(), []);
}

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

// ownership source for coverage (#445) and the shared badge (#305): /me/feeds when signed in
// (undefined offline: tell nothing rather than wrong); a demo/offline device holds nobody else's rows
export function useMyFeedIds(): ReadonlySet<string> | undefined {
  const { store } = useData();
  const syncing = connectorsAvailable();
  return useQuery(
    store,
    async () => {
      if (syncing) return fetchMyFeedIds().catch(() => undefined);
      return new Set((await store.allRows('account')).map((account) => account.spaceId));
    },
    [syncing],
  );
}

export function useSpaceStoreConnLinks(): StoreConnLinkRow[] | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => (await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0),
    [spaceId],
  );
}

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

export interface ConnectorAccountView {
  account: AccountRow;
  /** attachedBy: whose connection feeds it */
  attachedTo: { spaceId: string; name: string; attachedBy?: string }[];
}

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

const includedConnections = async (store: StorageBackend, spaceId: string): Promise<Set<string>> =>
  new Set((await store.bySpace('storeConnLink', spaceId)).filter((l) => l.deleted === 0).map((l) => l.instanceId));

/** #567: photos kept without a transaction belong to all the person's spaces; newest first */
async function attachableRows(store: StorageBackend, spaceId: string, feedId: string): Promise<ReceiptRow[]> {
  const included = await includedConnections(store, spaceId);
  const rows = (await store.bySpace('receipt', feedId)).filter(
    (r) => r.deleted === 0 && (r.source === 'photo' || (r.instanceId != null && included.has(r.instanceId))),
  );
  rows.sort((a, b) => b.date.localeCompare(a.date));
  return rows;
}

async function linkFacts(
  store: StorageBackend,
  spaceId: string,
): Promise<{ attachedTo: Map<string, string[]>; rejectedFor: Map<string, string[]>; heldTxIds: Set<string> }> {
  const attachedTo = new Map<string, string[]>();
  const rejectedFor = new Map<string, string[]>();
  const heldTxIds = new Set<string>();
  for (const link of await store.bySpace('receiptLink', spaceId)) {
    if (link.deleted !== 0) continue;
    const held = linkedTxIds(link);
    for (const txId of held) heldTxIds.add(txId);
    if (!link.receiptId) continue;
    if (held.length > 0) attachedTo.set(link.receiptId, held);
    if (link.rejectedTxIds?.length) rejectedFor.set(link.receiptId, link.rejectedTxIds);
  }
  return { attachedTo, rejectedFor, heldTxIds };
}

const attachedTxIds = async (store: StorageBackend, spaceId: string): Promise<Map<string, string[]>> => (await linkFacts(store, spaceId)).attachedTo;

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

/** a receipt attached elsewhere is still on offer and says where it is */
export interface AttachableReceipts {
  rows: ReceiptRow[];
  /** the transactions each receipt is attached to in this space, by receipt id — absent = not attached */
  attachedTo: Map<string, string[]>;
  /** #496: the transactions each receipt was taken off or turned down for — never suggested there again */
  rejectedFor: Map<string, string[]>;
  heldTxIds: Set<string>;
}

// several payments can share one receipt: the picker lists it under each and says where it already sits
export function useAttachableReceipts(): AttachableReceipts | undefined {
  const { store, spaceId } = useData();
  return useQuery(
    store,
    async () => {
      const facts = await linkFacts(store, spaceId);
      const feedId = myStoreFeedId();
      return { rows: feedId ? await attachableRows(store, spaceId, feedId) : [], ...facts };
    },
    [spaceId],
  );
}

/** #565: the same inventory outside a screen — the review's suggestion pass reads it when rows land */
export async function attachableReceiptsOf(store: StorageBackend, spaceId: string): Promise<AttachableReceipts> {
  const facts = await linkFacts(store, spaceId);
  const feedId = myStoreFeedId();
  return { rows: feedId ? await attachableRows(store, spaceId, feedId) : [], ...facts };
}

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

// derived from the rows themselves, so a card's "from … to …" is never a claim
async function receiptRanges(store: StorageBackend, ranges: Record<string, FetchedRange>): Promise<void> {
  const feedId = myStoreFeedId();
  if (!feedId) return;
  for (const receipt of await store.bySpace('receipt', feedId)) {
    if (receipt.deleted === 0 && receipt.instanceId) widen(ranges, receipt.instanceId, receipt.date);
  }
}

export const accountRangeKey = (accountId: string): string => `account:${accountId}`;

// per account: crediting every connection of a party with all its accounts put ING and ASN history under PayPal (#524)
async function bankRanges(store: StorageBackend, ranges: Record<string, FetchedRange>): Promise<void> {
  const accounts = (await store.allRows('account')).filter((a) => a.deleted === 0 && a.source === 'connector');
  for (const feed of new Set(accounts.map((a) => a.spaceId))) {
    const ids = new Set(accounts.filter((a) => a.spaceId === feed).map((a) => a.id));
    for (const tx of await store.bySpace('transaction', feed)) {
      if (tx.deleted === 0 && ids.has(tx.accountId)) widen(ranges, accountRangeKey(tx.accountId), tx.date);
    }
  }
}

export function mergedRange(ranges: Readonly<Record<string, FetchedRange>> | undefined, accountIds: readonly string[]): FetchedRange | undefined {
  let merged: FetchedRange | undefined;
  for (const id of accountIds) {
    const range = ranges?.[accountRangeKey(id)];
    if (!range) continue;
    merged = merged
      ? { count: merged.count + range.count, from: range.from < merged.from ? range.from : merged.from, to: range.to > merged.to ? range.to : merged.to }
      : { ...range };
  }
  return merged;
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
  reconnect: boolean;
  label?: string;
}

export interface AdoptResult {
  connectionId: string;
  /** an existing connection looks like the SAME party account (warning) */
  duplicateOf?: string;
}

export interface ConnectionOps {
  /** no space inclusion: that is picked afterwards */
  adopt: (args: AdoptArgs) => Promise<AdoptResult>;
  rename: (connectionId: string, displayName: string) => Promise<void>;
  setIcon: (connectionId: string, icon: string | null) => Promise<void>;
  /** ruling 2: unmatched receipts die with the connection; links survive */
  remove: (connectionId: string) => Promise<void>;
  syncNow: (connectionId: string, options?: Pick<SyncOptions, 'onChallenge' | 'onProgress'>) => Promise<SyncReport>;
  setIncludedSpaces: (connectionId: string, spaceIds: string[]) => Promise<void>;
  /** #441 L1: yes keeps the failure picture for the people who run munni, no deletes it */
  answerReport: (connectionId: string, jobId: string, share: boolean) => Promise<void>;
  setReportFailures: (connectionId: string, always: boolean) => Promise<void>;
}

const hashIdentity = async (provider: string, identity: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${provider}:${identity}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const defaultName = (metas: readonly StoreConnRow[], base: string): string => {
  const taken = new Set(metas.filter((m) => m.deleted === 0).map((m) => m.displayName));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }
};

const metaOf = async (storage: StorageBackend, connectionId: string): Promise<StoreConnRow | undefined> =>
  (await storage.allRows('storeConn')).find((c) => c.id === connectionId && c.deleted === 0);

// one adoption per connection at a time: the relay hands a bundle to one reader and crossing reads must not
// overwrite each other's device row
const adopting = new Map<string, Promise<unknown>>();

function inTurn<T>(connectionId: string, work: () => Promise<T>): Promise<T> {
  const mine = (adopting.get(connectionId) ?? Promise.resolve()).catch(() => undefined).then(work);
  adopting.set(connectionId, mine);
  const done = () => {
    if (adopting.get(connectionId) === mine) adopting.delete(connectionId);
  };
  mine.then(done, done);
  return mine;
}

async function keepDeviceRow(storage: StorageBackend, connectionId: string, provider: string, view: SessionView): Promise<void> {
  const existing = await storage.connectorConnGet(connectionId);
  // #430: the same sign-in answered again leaves the row alone; rewriting it dropped the bundle the first answer brought
  if (existing?.sessionId === view.sessionId && existing.state === view.state) {
    if (view.credentialBundle && view.credentialBundle !== existing.credentialBundle) {
      await storage.connectorConnPut({ ...existing, credentialBundle: view.credentialBundle });
    }
    if (view.bundle) await keepBundle(storage, connectionId, view.bundle);
    return;
  }
  await storage.connectorConnPut({
    id: connectionId,
    provider,
    credentialBundle: view.credentialBundle ?? existing?.credentialBundle,
    sessionId: view.sessionId,
    state: view.state,
    refreshedAt: new Date().toISOString(),
    lastSyncAt: existing?.lastSyncAt,
    // the days still to fetch are the connection's, not the session's
    backfill: existing?.backfill,
    // the standing answer outlives the session (a re-login wiped it and the question came back); the old error and job do not
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

  const adoptOne = async ({ manifest, view, connectionId, reconnect, label }: AdoptArgs): Promise<AdoptResult> => {
    await keepDeviceRow(storage, connectionId, manifest.id, view);
    void pushConnection(storage, connectionId).catch(() => undefined);
    const known = await metaOf(storage, connectionId);
    // a connection that exists is signed in again — also when a new one's sign-in is answered a second time:
    // naming it afresh would call it "… 2" and report it as a duplicate of itself
    if (reconnect || known) {
      if (known) await repo.upsert('storeConn', known.spaceId, connectionId, { status: 'ok' });
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
    // a connection is the person's, not a space's: nothing joins a space by itself; a shop's spaces are picked after naming,
    // a bank's accounts are attached one by one on the space's accounts screen
    void logActivity(storage, repo, spaceId, 'storeConnect', displayName);
    firstSync(connectionId);
    return { connectionId, duplicateOf };
  };

  return {
    adopt: (args) => inTurn(args.connectionId, () => adoptOne(args)),
    rename: async (connectionId, displayName) => {
      const meta = await metaOf(storage, connectionId);
      if (!meta || !displayName.trim()) return;
      await repo.upsert('storeConn', meta.spaceId, connectionId, { displayName: displayName.trim() });
      // members render the snapshot on the link rows; #505: a space the person only reads keeps its snapshot
      for (const link of await allLinksOf(connectionId)) {
        await repo.upkeep().upsert('storeConnLink', link.spaceId, link.id, { displayName: displayName.trim() });
      }
      void logActivity(storage, repo, spaceId, 'storeEdit', displayName.trim());
    },
    setIcon: async (connectionId, icon) => {
      const meta = await metaOf(storage, connectionId);
      if (!meta) return;
      await repo.upsert('storeConn', meta.spaceId, connectionId, { icon: icon ?? (null as never) });
      for (const link of await allLinksOf(connectionId)) {
        await repo.upkeep().upsert('storeConnLink', link.spaceId, link.id, { icon: icon ?? (null as never) });
      }
      void logActivity(storage, repo, spaceId, 'storeEdit', meta.displayName);
    },
    remove: async (connectionId) => {
      const device = await storage.connectorConnGet(connectionId);
      if (device?.sessionId) {
        const bundle = await readBundle(storage, connectionId);
        await connectorApi.disconnect(device.provider, device.sessionId, bundle).catch((err: unknown) => {
          if (!(err instanceof ConnectorError)) throw err;
        });
      } else if (connectorsAvailable()) {
        // made on another device: end the relay's binding by connection id without a bundle (that custody is not ours to hand over);
        // a relay that is away or knows nothing of it leaves the rows here to be removed anyway
        const binding = (await connectorApi.sessions().catch(() => [] as BindingView[])).find((row) => row.connectionId === connectionId);
        if (binding) await connectorApi.disconnect(binding.provider, binding.sessionId).catch(() => undefined);
      }
      // ruling 2: global receipts die with the connection; space snapshots (linked receipts) stay
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
        await repo.upkeep().remove('storeConnLink', link.spaceId, link.id);
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
        await reevaluateSpace(storage, repo, id, connectionId);
        void logActivity(storage, repo, id, 'storeAttach', meta.displayName);
      }
      for (const link of current.filter((l) => !spaceIds.includes(l.spaceId))) {
        if (!repo.canWrite(link.spaceId)) continue; // #505: a space they only read keeps its link
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
    // a job accepted earlier and never collected is due now, whatever the clock says
    if (row.lastSyncAt && !row.pendingJob && Date.now() - Date.parse(row.lastSyncAt) < dueMs) continue;
    if (!(await readBundle(storage, row.id))) continue;
    await syncConnection(storage, repo, row.id, options).catch(() => undefined);
  }
}

// R4: receipts follow the bank: once per app open, then after each clean sync cycle, due connections re-pull;
// a question a party asks meanwhile waits for the hub
export function useConnectionKeepAlive(): void {
  const { store: storage, repo, engine } = useData();
  const ran = useRef(false);
  const lastAuto = useRef(0);
  // a sync cycle that brought new rows asks the matcher for a pass, so proposals stand before the review opens
  useReceiptMatchTriggers();

  useEffect(() => {
    if (ran.current || !connectorsAvailable() || !navigator.onLine) return;
    ran.current = true;
    void (async () => {
      // E2EE sync (opt-in): adopt fresher sibling bundles first, publish what this device rotated afterwards
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
