import { visibleAccounts, visibleTransactions } from '@/db/joined';
import type { SpaceTx } from '@/db/joined';
import { buildMerchantMemory } from '@/domain/merchantMemory';
import type { MemoryInput, MerchantMemory } from '@/domain/merchantMemory';
import { CATEGORY_BY_ID } from '@/domain/categories';
import { isMintedLeg } from '@/domain/feedIds';
import { accountStamp } from '@/domain/txType';
import type { StorageBackend } from '@/db/backend';

/**
 * Merchant memory is user-scoped and LOCAL-ONLY (user ruling): every
 * space this device knows teaches every other — labeling Albert Heijn
 * in space X informs the suggestion when space Y sees a similar charge.
 *
 * #161 (user rule): the OWN space answers first; other spaces are the
 * fallback when the own history has nothing for the merchant. Rows
 * from other spaces only teach with catalog (builtin) categories — a
 * prediction never names a category the target space cannot see — and
 * never teach spreads or events (both are space-scoped facts). The
 * prediction itself renders only on this user's device; only what the
 * user then CONFIRMS syncs to co-members.
 */
export interface SpaceMemory {
  own: MerchantMemory;
  others: MerchantMemory;
}

/** where a pass reads each space's view of its transactions */
export type SpaceViews = (spaceId: string) => Promise<SpaceTx[]>;

/**
 * #554: one read of each space's view per pass — every space's memory
 * reads every space, so a pass over S spaces joined S + S² times (the
 * join is the cost: the feed rows and the overlays read whole).
 */
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
  // 2026-10-09 (user: Confirm stalled): only real spaces teach — a bank
  // feed or the private state space carries no kind and no categorised
  // row, and joining a feed's whole history for nothing doubled the cost
  // of every rebuild on a large account
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  const ownRows: MemoryInput[] = [];
  const otherRows: MemoryInput[] = [];
  for (const space of spaces) {
    const [txs, accounts] = await Promise.all([views(space.id), visibleAccounts(store, space.id)]);
    const typeOf = new Map(accounts.map((a) => [a.id, a.type]));
    // #564 (user ss): a minted counter leg is munni's own bookkeeping, filed
    // from the pot's side under the SOURCE's merchant — it taught "Set aside"
    // to money coming back from savings. And a special account's own rows
    // teach only rows on the same kind of ledger.
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
