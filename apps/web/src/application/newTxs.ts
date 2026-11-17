import { useEffect, useMemo } from 'react';
import { useData } from '@/app/data';
import { readSessionIdentity } from '@/app/session';
import { useQuery } from '@/db/useQuery';
import type { SpaceTx } from '@/db/joined';
import type { TxSeenRow } from '@/db/types';
import { isMintedLeg } from '@/domain/feedIds';
import { bornAtMs, txSeenBaseId, txSeenRowId, userStateSpaceId } from '@/domain/userState';

const KEY_PREFIX = 'txNew_';
const KNOWN_CAP = 1500;
const NEW_TTL_MS = 24 * 60 * 60 * 1000;

interface NewMarker {
  known: string[];
  fresh: Record<string, number>;
}

// signed-in: first-seen rows sync through the private state space (domain/userState), so one clock spans devices;
// a per-space baseline row marks when the scheme started, so history never floods a fresh device.
// Offline/demo keep a device-local marker: no server to agree through.
export function useNewTransactions(txs: SpaceTx[] | undefined): { newTxs: SpaceTx[]; newIds: ReadonlySet<string> } {
  const { store, repo, spaceId } = useData();
  const identity = readSessionIdentity();
  const stateSpaceId = identity?.kind === 'user' ? userStateSpaceId(identity.sub) : null;

  const seenRows = useQuery(
    store,
    // #296: a backend missing the entity must degrade to "nothing new",
    // never crash the screen that mounted the hook
    async () => (stateSpaceId ? await store.bySpace('txSeen', stateSpaceId).catch(() => []) : null),
    [stateSpaceId],
    undefined,
    `txSeen:${stateSpaceId ?? '-'}`, // #361: remount cache
  );
  const spaceSeen = useMemo(
    () => (seenRows ?? []).filter((row) => row.deleted === 0 && row.forSpaceId === spaceId),
    [seenRows, spaceId],
  );
  const baseline = useMemo(() => spaceSeen.find((row) => row.baseline === 1), [spaceSeen]);

  const key = KEY_PREFIX + spaceId;
  const marker = useQuery(
    store,
    async () => {
      if (stateSpaceId) return null;
      return ((await store.metaGet(key))?.value as NewMarker | undefined) ?? null;
    },
    [spaceId, stateSpaceId],
    undefined,
    `newMarker:${spaceId}:${stateSpaceId ?? '-'}`, // #361: remount cache
  );

  // #515: the counter leg munni mints itself arrives with its source, never as a new transaction
  const arrivals = useMemo(() => txs?.filter((tx) => !isMintedLeg(tx)), [txs]);

  useEffect(() => {
    if (!arrivals) return;
    if (stateSpaceId) {
      if (seenRows === undefined) return;
      void labelSynced(repo, stateSpaceId, spaceId, arrivals, spaceSeen, baseline).catch(() => undefined);
      return;
    }
    if (marker === undefined) return;
    void labelLocal(store, key, arrivals, marker).catch(() => undefined);
  }, [arrivals, seenRows, spaceSeen, baseline, marker, store, repo, key, spaceId, stateSpaceId]);

  const labeled = useMemo(() => {
    const now = Date.now();
    if (stateSpaceId) {
      return new Set(
        spaceSeen
          .filter((row) => row.baseline !== 1 && row.txId && now - row.labeledAt < NEW_TTL_MS)
          .map((row) => row.txId!),
      );
    }
    if (!marker) return new Set<string>();
    return new Set(
      Object.entries(marker.fresh)
        .filter(([, at]) => now - at < NEW_TTL_MS)
        .map(([id]) => id),
    );
  }, [stateSpaceId, spaceSeen, marker]);

  // a leg labeled before #515 still wears its clock — the arrivals decide what lists
  const { newTxs, newIds } = useMemo(() => {
    const rows = (arrivals ?? [])
      .filter((tx) => tx.deleted === 0 && labeled.has(tx.id))
      .sort((a, b) => b.date.localeCompare(a.date));
    return { newTxs: rows, newIds: new Set(rows.map((tx) => tx.id)) as ReadonlySet<string> };
  }, [arrivals, labeled]);

  return { newTxs, newIds };
}

async function labelSynced(
  repo: ReturnType<typeof useData>['repo'],
  stateSpaceId: string,
  spaceId: string,
  txs: SpaceTx[],
  spaceSeen: TxSeenRow[],
  baseline: TxSeenRow | undefined,
): Promise<void> {
  const now = Date.now();
  if (!baseline) {
    await repo.upsert('txSeen', stateSpaceId, txSeenBaseId(spaceId), {
      forSpaceId: spaceId,
      labeledAt: now,
      baseline: 1 as const,
    });
    return;
  }
  const seenTxIds = new Set(spaceSeen.map((row) => row.txId).filter(Boolean));
  for (const tx of txs) {
    if (tx.deleted !== 0 || seenTxIds.has(tx.id)) continue;
    if (bornAtMs(tx.fieldVersions) <= baseline.labeledAt) continue;
    await repo.upsert('txSeen', stateSpaceId, txSeenRowId(spaceId, tx.id), { forSpaceId: spaceId, txId: tx.id, labeledAt: now });
  }
}

async function labelLocal(
  store: ReturnType<typeof useData>['store'],
  key: string,
  txs: SpaceTx[],
  marker: NewMarker | null,
): Promise<void> {
  const now = Date.now();
  if (marker === null) {
    await store.metaPut(key, {
      known: txs.slice(0, KNOWN_CAP).map((t) => t.id),
      fresh: {},
    } satisfies NewMarker);
    return;
  }
  const known = new Set(marker.known);
  const fresh: Record<string, number> = {};
  let changed = false;
  for (const [id, at] of Object.entries(marker.fresh)) {
    if (now - at < NEW_TTL_MS) fresh[id] = at;
    else changed = true;
  }
  for (const tx of txs) {
    if (tx.deleted !== 0 || known.has(tx.id)) continue;
    known.add(tx.id);
    fresh[tx.id] = now;
    changed = true;
  }
  if (!changed) return;
  await store.metaPut(key, {
    known: [...known].slice(-KNOWN_CAP),
    fresh,
  } satisfies NewMarker);
}
