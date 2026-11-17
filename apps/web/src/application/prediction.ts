import { visibleAccounts, visibleTransactions } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import { buildMerchantMemory } from '@/domain/merchantMemory';
import type { MemoryInput, MerchantMemory } from '@/domain/merchantMemory';
import { CATEGORY_BY_ID } from '@/domain/categories';
import { isMintedLeg } from '@/domain/feedIds';
import { accountStamp } from '@/domain/txType';
import type { StorageBackend } from '@/db/backend';

// merchant memory is user-scoped and local-only: every space teaches every other, the own space answers first (#161)
// other spaces teach only catalog categories, never spreads or events; only what the user confirms syncs
export interface SpaceMemory {
  own: MerchantMemory;
  others: MerchantMemory;
}

export type SpaceViews = (spaceId: string) => Promise<SpaceTx[]>;

/** one read of each space's view per pass: every space's memory reads every space, so S + S² joins otherwise (#554) */
export function memoViews(store: StorageBackend): SpaceViews {
  const views = new Map<string, Promise<SpaceTx[]>>();
  return (spaceId) => {
    let view = views.get(spaceId);
    if (!view) {
      view = visibleTransactions(store, spaceId);
      views.set(spaceId, view);
    }
    return view;
  };
}

export async function buildSpaceMerchantMemory(store: StorageBackend, spaceId: string, views: SpaceViews = memoViews(store)): Promise<SpaceMemory> {
  // only real spaces teach (they carry a kind): joining a feed's whole history doubled every rebuild on a large account
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  const ownRows: MemoryInput[] = [];
  const otherRows: MemoryInput[] = [];
  for (const space of spaces) {
    const [txs, accounts] = await Promise.all([views(space.id), visibleAccounts(store, space.id)]);
    const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
    // a minted counter leg is munni's bookkeeping filed from the pot's side; it taught "Set aside" to money back (#564)
    // a special account's own rows teach only rows on the same kind of ledger
    const taught = txs
      .filter((t) => !isMintedLeg(t))
      .map((t) => ({ ...t, ledger: accountStamp(typeOf.get(t.accountId)) }));
    if (space.id === spaceId) ownRows.push(...taught);
    else {
      otherRows.push(
        ...taught
          .filter((t) => CATEGORY_BY_ID.has(t.catId ?? ''))
          .map((t) => ({ ...t, cats: undefined, eventId: undefined })),
      );
    }
  }
  return { own: buildMerchantMemory(ownRows), others: buildMerchantMemory(otherRows) };
}
