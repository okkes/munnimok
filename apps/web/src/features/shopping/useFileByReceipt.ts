import { useCallback } from 'react';
import { useData } from '@/app/data';
import { fileByReceipt } from '@/application/receiptFiling';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { useCategories } from '@/features/categories/useCategories';

/** #567: after an attach or a read outside the review, the payment is filed by its receipt where the two agree */
export function useFileByReceipt(): (txId: string) => Promise<boolean> {
  const { store, repo, spaceId } = useData();
  const cats = useCategories();
  return useCallback(
    (txId) => fileByReceipt(store, repo, spaceId, txId, (catId) => catId !== UNCATEGORIZED_ID && cats.byId(catId).id === catId),
    [store, repo, spaceId, cats],
  );
}
