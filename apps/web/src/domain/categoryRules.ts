import type { CatDirection, TransactionRow, TxType, TxView } from '@/db/types';
import { UNCATEGORIZED_ID } from './categories';

// the sign is bank truth (negative = debit); a category fits when its type matches and its direction allows the side;
// edits that break assignments are warned about first, then reset to Uncategorized and flagged for review

export const directionOfTx = (tx: Pick<TxView, 'amountCents'>): 'debit' | 'credit' =>
  tx.amountCents < 0 ? 'debit' : 'credit';

export const directionAllows = (direction: CatDirection | undefined, side: 'debit' | 'credit'): boolean =>
  !direction || direction === 'both' || direction === side;

export function subtreeIds(parentId: string, cats: { id: string; parentId?: string }[]): Set<string> {
  const ids = new Set<string>([parentId]);
  for (const cat of cats) if (cat.parentId === parentId) ids.add(cat.id);
  return ids;
}

const usesCat = (tx: TxView, catIds: Set<string>): boolean =>
  (tx.catId !== undefined && catIds.has(tx.catId))
  || (tx.splits ?? []).some((s) => catIds.has(s.catId) || (s.cats ?? []).some((c) => catIds.has(c.catId)))
  || (tx.cats ?? []).some((c) => catIds.has(c.catId));

export function affectedByTypeChange(txs: TxView[], catIds: Set<string>, newType: TxType): TxView[] {
  return txs.filter((tx) => tx.deleted === 0 && usesCat(tx, catIds) && tx.txType !== newType);
}

export function affectedByDirectionChange(
  txs: TxView[],
  catId: string,
  newDirection: CatDirection,
): TxView[] {
  const ids = new Set([catId]);
  return txs.filter((tx) => tx.deleted === 0 && usesCat(tx, ids) && !directionAllows(newDirection, directionOfTx(tx)));
}

export function affectedByDelete(txs: TxView[], catIds: Set<string>): TxView[] {
  return txs.filter((tx) => tx.deleted === 0 && usesCat(tx, catIds));
}

/** detach to Uncategorized + review flag; split parts and `cats` spreads (#211) lose the category, keep amounts */
export function detachCategoryPatch(
  tx: TxView,
  catIds: Set<string>,
): Partial<Pick<TransactionRow, 'catId' | 'splits' | 'cats' | 'needsReview'>> {
  const patch: Partial<Pick<TransactionRow, 'catId' | 'splits' | 'cats' | 'needsReview'>> = { needsReview: 1 };
  const detachCats = <T extends { catId: string }>(entries: T[]): T[] =>
    entries.map((c) => (catIds.has(c.catId) ? { ...c, catId: UNCATEGORIZED_ID } : c));
  if (tx.catId !== undefined && catIds.has(tx.catId)) patch.catId = UNCATEGORIZED_ID;
  if ((tx.splits ?? []).some((s) => catIds.has(s.catId) || (s.cats ?? []).some((c) => catIds.has(c.catId)))) {
    patch.splits = tx.splits!.map((s) => ({
      ...s,
      ...(catIds.has(s.catId) ? { catId: UNCATEGORIZED_ID } : {}),
      ...(s.cats?.length ? { cats: detachCats(s.cats) } : {}),
    }));
  }
  if ((tx.cats ?? []).some((c) => catIds.has(c.catId))) patch.cats = detachCats(tx.cats!);
  return patch;
}
