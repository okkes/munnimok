import { specialCatType } from './categories';
import type { AccountRow } from '@/db/types';

// #546: family default accounts retire (a movement names a real account); the cash wallet is the one default kept:
// the ATM pair's counterparty, the person's own and deletable (#348). Other families' rows stay until the retire pass.
// Deterministic ids make two devices converge by LWW instead of duplicating.
export type DefaultFamily = NonNullable<AccountRow['defaultFor']>;

const COUNTER_FAMILIES: ReadonlySet<string> = new Set(['saving', 'debtPayment', 'investment', 'transfer', 'cash', 'funding']);

export const defaultAccountId = (spaceId: string, family: DefaultFamily): string =>
  `defaultacct_${family}_${spaceId}`;

export const cashWalletId = (spaceId: string): string => defaultAccountId(spaceId, 'cash');

export const isRetiredDefault = (account: Pick<AccountRow, 'defaultFor'>): boolean =>
  !!account.defaultFor && account.defaultFor !== 'cash';

/** the counterparty family of a movement category: the ATM pair is cash; null outside the special trees */
export function defaultFamilyFor(catId: string | undefined): DefaultFamily | null {
  if (catId === 'cashWithdraw' || catId === 'cashDeposit') return 'cash';
  const family = specialCatType(catId);
  return family && COUNTER_FAMILIES.has(family) ? (family as DefaultFamily) : null;
}
