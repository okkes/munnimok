// #275: creating a category mid-review detours to /categories; the deck returns to the SAME card with the editor reopened
// read-once module state, stashed only by the create-category door; other ways of leaving review reset as before
export interface ReviewReturnState {
  skippedIds: readonly string[];
  txId: string;
  reopenCats: boolean;
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
