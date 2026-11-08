import type { AccountRow, SpaceRow } from '@/db/types';
import { SPEND_TYPES, isSpendAccount } from './safeToSpend';

/**
 * The Home balance band's meaning, per space (user design 2026-08-01):
 * net worth (every attached account — the pre-config behavior and the
 * default), total cash (liquid types only), safe-to-spend (its number,
 * over the accounts safe to spend sums — #541: those read highlighted), or
 * a hand-picked set of accounts. Only custom takes toggles here; safe to
 * spend picks its accounts on its own screen.
 */
export type BalanceBandMode = 'networth' | 'cash' | 'spendable' | 'custom';

export const BAND_MODES: readonly BalanceBandMode[] = ['networth', 'cash', 'spendable', 'custom'];

/** the account types that are money in hand — the balance trend reads the same set (user 2026-10-08) */
export const LIQUID_TYPES: ReadonlySet<AccountRow['type']> = new Set<AccountRow['type']>(['checking', 'savings', 'cash']);

type BandSpace = Pick<SpaceRow, 'balanceBandMode' | 'balanceBandAccounts' | 'spendAccountIds'>;
type BandAccount = Pick<AccountRow, 'id' | 'type' | 'deleted' | 'archived'>;

export const bandModeOf = (space: BandSpace | undefined): BalanceBandMode => space?.balanceBandMode ?? 'networth';

/** #142 (user): the premade modes are premade — only "Picked accounts"
 *  takes per-account modification; net worth / total cash / safe-to-
 *  spend are fixed formulas */
export const bandEditable = (mode: BalanceBandMode): boolean => mode === 'custom';

/** does this account belong to the mode's FORMULA? (sum membership) */
export function bandEligible(mode: BalanceBandMode, account: Pick<AccountRow, 'type'>): boolean {
  // #152: a funding account is someone else's pot — its balance never
  // counts toward this space's numbers, under any mode
  if (account.type === 'funding') return false;
  if (mode === 'spendable') return SPEND_TYPES.has(account.type);
  if (mode === 'cash') return LIQUID_TYPES.has(account.type);
  return true;
}

/** does the account count toward the band under this mode + config?
 *  #142: the premade sums ignore any stored exclusions — the formula is
 *  the formula; only custom reads its hand-picked list */
export function bandIncludes(mode: BalanceBandMode, account: BandAccount, space: BandSpace | undefined): boolean {
  if (!bandEligible(mode, account)) return false;
  if (mode === 'custom') return (space?.balanceBandAccounts ?? []).includes(account.id);
  if (mode === 'spendable') return isSpendAccount(account, space);
  return true;
}
