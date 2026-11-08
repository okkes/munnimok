import { specialCatType } from './categories';
import type { AccountRow } from '@/db/types';

/**
 * #546 (user 2026-10-22): the family DEFAULT accounts of #221 retire —
 * "things are getting bloated". A movement names a real account now, and
 * the cash wallet is the one default a space keeps: the ATM pair's
 * counterparty, minted with the space (#348: the person's own, deletable).
 * The other families' rows stay a stored value until the boot's retire
 * pass folds them away (application/defaultAccounts).
 *
 * Deterministic ids make two devices converge by LWW instead of
 * duplicating (the loans-v2 fold lesson). This module is the pure half:
 * ids and family math; the minting lives in application/defaultAccounts.
 */
export type DefaultFamily = NonNullable<AccountRow['defaultFor']>;

/** the counterparty families of the movement categories */
const COUNTER_FAMILIES: ReadonlySet<string> = new Set(['saving', 'debtPayment', 'investment', 'transfer', 'cash', 'funding']);

export const defaultAccountId = (spaceId: string, family: DefaultFamily): string =>
  `defaultacct_${family}_${spaceId}`;

/** the space's cash wallet — the default that stays (#546) */
export const cashWalletId = (spaceId: string): string => defaultAccountId(spaceId, 'cash');

/** a default of a retired family (#546): every default but the cash wallet */
export const isRetiredDefault = (account: Pick<AccountRow, 'defaultFor'>): boolean =>
  !!account.defaultFor && account.defaultFor !== 'cash';

/**
 * The counterparty FAMILY a category belongs to — the bijection read
 * toward the accounts. The ATM pair is the cash family (the wallet's);
 * every other special category follows its family. Null for categories
 * outside the special trees.
 */
export function defaultFamilyFor(catId: string | undefined): DefaultFamily | null {
  if (catId === 'cashWithdraw' || catId === 'cashDeposit') return 'cash';
  const family = specialCatType(catId);
  return family && COUNTER_FAMILIES.has(family) ? (family as DefaultFamily) : null;
}
