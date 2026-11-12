import { useMemo } from 'react';
import { useItemMemory } from '@/application/receiptLinks';
import type { ReceiptOps } from '@/application/receipts';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { receiptLinkId } from '@/domain/feedIds';
import { receiptFiling } from '@/domain/receiptCats';
import { withCats } from '@/domain/reviewDraft';
import type { ReviewDraft } from '@/domain/reviewDraft';
import type { ReceiptPick, ReceiptRow } from '@/db/types';
import type { Catalog } from '@/features/categories/useCategories';

/** the card filed by its receipt's lines: the draft it shows, and the lines it came from */
export interface ReceiptFiled {
  draft: ReviewDraft;
  picks: ReceiptPick[];
  receiptId: string;
}

/**
 * #567 (user): a receipt that says the card's own amount files it by its
 * lines — the card shows that filing and Confirm writes it. A category
 * staged by hand outranks it, and so does "no receipt" (no receipt handed).
 */
export function useReceiptFiled(
  tx: { amountCents: number } | undefined,
  base: ReviewDraft | null,
  staged: ReviewDraft | null,
  receipt: Pick<ReceiptRow, 'id' | 'totalCents' | 'items'> | null,
  cats: Catalog,
): ReceiptFiled | null {
  const memory = useItemMemory();
  return useMemo(() => {
    if (!tx || !base || staged || !receipt) return null;
    const known = (catId: string) => catId !== UNCATEGORIZED_ID && cats.byId(catId).id === catId;
    const filing = receiptFiling({ ...base, amountCents: tx.amountCents }, receipt, memory, known);
    return filing ? { draft: withCats(base, filing.cats), picks: filing.picks, receiptId: receipt.id } : null;
  }, [tx, base, staged, receipt, memory, cats]);
}

/** the lines the confirmed categories came from stay with the receipt: the sheet reopens on them and the next receipt learns from them */
export async function keepFiledPicks(
  ops: Pick<ReceiptOps, 'setPicks'>,
  spaceId: string,
  txId: string,
  filed: ReceiptFiled | null,
  attached: { receiptId?: string; linkId?: string },
): Promise<void> {
  if (!filed) return;
  const held = attached.receiptId === filed.receiptId ? attached.linkId : undefined;
  await ops.setPicks(held ?? receiptLinkId(spaceId, filed.receiptId), txId, filed.picks);
}
