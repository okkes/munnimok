import type { AccountRow, SpaceRow } from '@/db/types';
import { SPEND_TYPES, isSpendAccount } from './safeToSpend';

// the Home balance band's meaning per space: networth (default), cash (liquid types), spendable (safe-to-spend number
// over its accounts, #541), custom (hand-picked); only custom takes toggles here
export type BalanceBandMode = 'networth' | 'cash' | 'spendable' | 'custom';

export const BAND_MODES: readonly BalanceBandMode[] = ['networth', 'cash', 'spendable', 'custom'];

/** account types that are money in hand; the balance trend reads the same set */
export const LIQUID_TYPES: ReadonlySet<AccountRow['type']> = new Set<AccountRow['type']>(['checking', 'savings', 'cash']);

type BandSpace = Pick<SpaceRow, 'balanceBandMode' | 'balanceBandAccounts' | 'spendAccountIds'>;
type BandAccount = Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived'>;

export const bandModeOf = (space: BandSpace | undefined): BalanceBandMode => space?.balanceBandMode ?? 'networth';

/** #142: premade modes are fixed formulas; only custom ("Picked accounts") takes per-account modification */
export const bandEditable = (mode: BalanceBandMode): boolean => mode === 'custom';

export function bandEligible(mode: BalanceBandMode, account: Pick<AccountRow, 'type'>): boolean {
  // #152: a funding account is someone else's pot — its balance never
  // counts toward this space's numbers, under any mode
  if (account.type === 'funding') return false;
  if (mode === 'spendable') return SPEND_TYPES.has(account.type);
  if (mode === 'cash') return LIQUID_TYPES.has(account.type);
  return true;
}

/** #142: premade sums ignore stored exclusions; only custom reads its hand-picked list */
export function bandIncludes(mode: BalanceBandMode, account: BandAccount, space: BandSpace | undefined): boolean {
  if (!bandEligible(mode, account)) return false;
  if (mode === 'custom') return (space?.balanceBandAccounts ?? []).includes(account.id);
  if (mode === 'spendable') return isSpendAccount(account, space);
  return true;
}
