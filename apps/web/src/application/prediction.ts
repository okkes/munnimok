import { visibleTransactions } from '@/db/joined';
import { buildMerchantMemory } from '@/domain/merchantMemory';
import type { MerchantMemory } from '@/domain/merchantMemory';
import type { MunniDB } from '@/db/schema';

/**
 * Merchant memory scoped like category visibility: a shared space learns
 * only from its own (members') categorizations; a personal space learns
 * from ALL the user's personal spaces. Private habits never leak into a
 * shared space's predictions, and predictions never suggest categories
 * the target space cannot see.
 */
export async function buildSpaceMerchantMemory(db: MunniDB, spaceId: string): Promise<MerchantMemory> {
  const spaces = await db.spaces.filter((s) => s.deleted === 0).toArray();
  const target = spaces.find((s) => s.id === spaceId);
  if (target?.kind === 'shared') {
    return buildMerchantMemory(await visibleTransactions(db, spaceId));
  }
  const rows = [];
  for (const space of spaces.filter((s) => s.kind !== 'shared')) {
    rows.push(...(await visibleTransactions(db, space.id)));
  }
  return buildMerchantMemory(rows);
}
