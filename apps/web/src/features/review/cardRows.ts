import { UNCATEGORIZED_ID, specialCatType } from '@/domain/categories';
import type { ReviewDraft } from '@/domain/reviewDraft';

export interface CardRowGates {
  counter: boolean;
  recurring: boolean;
  event: boolean;
}

// #565: every row always stands, disabled when the filing cannot use it, never hidden. Counterparty: open while nothing is
// filed or for a special category (#339). Recurring: open before a category (#525), never for a debt payment.
// Event: ordinary spending only (#339). An adjustment takes none.
export function cardRowGates(
  draft: Pick<ReviewDraft, 'catId' | 'txType'> | null,
  opts: { recurringOwnsCategory: boolean; loanCounter: boolean },
): CardRowGates {
  const catId = draft?.catId;
  const filed = !!catId && catId !== UNCATEGORIZED_ID;
  const family = filed ? specialCatType(catId) : undefined;
  const adjustment = draft?.txType === 'adjustment';
  return {
    counter: !adjustment && !opts.recurringOwnsCategory && (!filed || !!family),
    recurring: !adjustment && !opts.loanCounter && family !== 'debtPayment',
    event: !adjustment && !family,
  };
}
