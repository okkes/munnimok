import { useEffect, useMemo } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import type { SpaceTx } from '@/db/joined';

const LEGACY_KEY = 'txSeen';
const KEY_PREFIX = 'txNew_';
const KNOWN_CAP = 1500;
const NEW_TTL_MS = 24 * 60 * 60 * 1000;

interface NewMarker {
  /** every id this device has ever registered for the space */
  known: string[];
  /** id → when it was labeled new (ms) — the 24h badge clock */
  fresh: Record<string, number>;
}

/**
 * "New transactions" (#148 r2, user spec): a row the device sees for the
 * FIRST time — linked, imported or created since the previous usage —
 * is labeled new and stays new for 24 hours from that labeling, then
 * quietly expires. Away three days? Those three days' arrivals all get
 * their 24h clock on the next open. Reviewing/categorizing does not
 * clear the label — the point is finding them to add notes, receipts
 * and the rest. Device-level and per space by design (what my phone has
 * shown me is not a property of the space, and space B's history must
 * not flood as "new" on the first visit).
 */
export function useNewTransactions(txs: SpaceTx[] | undefined): { newTxs: SpaceTx[]; newIds: ReadonlySet<string> } {
  const { store, spaceId } = useData();
  const key = KEY_PREFIX + spaceId;
  const marker = useQuery(
    store,
    async () => {
      const own = (await store.metaGet(key))?.value as NewMarker | undefined;
      if (own) return own;
      // migration: the old device-wide seen list seeds `known` so nothing
      // historic floods the block on the first run of the new scheme
      const legacy = (await store.metaGet(LEGACY_KEY))?.value as { ids?: string[] } | undefined;
      return legacy?.ids ? ({ known: legacy.ids, fresh: {} } satisfies NewMarker) : null;
    },
    [spaceId],
  );

  // label arrivals + expire old badges — one write per real change
  useEffect(() => {
    if (!txs || marker === undefined) return;
    void (async () => {
      const now = Date.now();
      if (marker === null) {
        // first sight of this space: everything counts as already seen
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
        else changed = true; // badge expired
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
    })().catch(() => undefined); // a closing db must not throw
  }, [txs, marker, store, key]);

  const newIds = useMemo(() => {
    if (!marker) return new Set<string>();
    const now = Date.now();
    return new Set(
      Object.entries(marker.fresh)
        .filter(([, at]) => now - at < NEW_TTL_MS)
        .map(([id]) => id),
    );
  }, [marker]);

  const newTxs = useMemo(() => {
    if (!txs) return [];
    return txs.filter((tx) => tx.deleted === 0 && newIds.has(tx.id)).sort((a, b) => b.date.localeCompare(a.date));
  }, [txs, newIds]);

  return { newTxs, newIds };
}
