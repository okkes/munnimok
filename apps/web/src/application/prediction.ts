import { visibleTransactions } from '@/db/joined';
import { buildMerchantMemory } from '@/domain/merchantMemory';
import type { MerchantMemory } from '@/domain/merchantMemory';
import { CATEGORY_BY_ID } from '@/domain/categories';
import type { MunniDB } from '@/db/schema';

/**
 * Merchant memory is user-scoped and LOCAL-ONLY (user ruling): every
 * space this device knows teaches every other — labeling Albert Heijn
 * in space X informs the suggestion when space Y sees a similar charge.
 * Rows from OTHER spaces only teach with catalog (builtin) categories,
 * so a prediction never names a category the target space cannot see.
 * The prediction itself renders only on this user's device; only the
 * category the user then CONFIRMS syncs to co-members.
 */
export async function buildSpaceMerchantMemory(db: MunniDB, spaceId: string): Promise<MerchantMemory> {
  const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
  const rows = [];
  for (const space of spaces) {
    const txs = await visibleTransactions(db, space.id);
    rows.push(...(space.id === spaceId ? txs : txs.filter((t) => CATEGORY_BY_ID.has(t.catId ?? ''))));
  }
  return buildMerchantMemory(rows);
}
