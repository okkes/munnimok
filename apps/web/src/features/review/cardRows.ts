import { UNCATEGORIZED_ID, specialCatType } from '@/domain/categories';
import type { ReviewDraft } from '@/domain/reviewDraft';

/** which of the card's link rows the current filing can use */
export interface CardRowGates {
  counter: boolean;
  recurring: boolean;
  event: boolean;
}

/**
 * #565 (user): every row of the review card always stands — a row the
 * filing has no use for is shown disabled, never hidden and never popping
 * in later. The rules:
 * - Counterparty: a movement's question — open while nothing is filed
 *   (counter-first: the account files its category) or for a special
 *   category; closed for an ordinary category, predicted or picked (#339)
 * - Recurring cost: open before any category too (#525: linking one files
 *   its category at once); a debt payment is never one (user 2026-07-29)
 * - Event: ordinary spending only — a savings move is no event (#339)
 * An adjustment is bookkeeping and takes none of them.
 */
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
