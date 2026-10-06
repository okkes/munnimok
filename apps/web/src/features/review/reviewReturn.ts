import type { ReviewDraft } from '@/domain/reviewDraft';
import type { ReceiptStage } from './reviewReceipt';

/**
 * #275 (user): creating a category mid-review detours to /categories and
 * back — the deck must return to the SAME card with the category editor
 * reopened, not restart from the top. Read-once module state, stashed
 * only by the create-category door (the old per-visit reset ruling
 * stands for every other way of leaving review).
 */
export interface ReviewReturnState {
  skippedIds: readonly string[];
  txId: string;
  reopenCats: boolean;
  /** 2026-10-06 (user): the receipt detour brings the card's staged picks back with it */
  draft?: ReviewDraft | null;
  note?: string | null;
  receipt?: ReceiptStage;
  bulk?: readonly string[];
}

let pending: ReviewReturnState | null = null;

export const setReviewReturn = (state: ReviewReturnState): void => {
  pending = state;
};

export const takeReviewReturn = (): ReviewReturnState | null => {
  const take = pending;
  pending = null;
  return take;
};
