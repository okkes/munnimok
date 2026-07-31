import type { TxType } from '@/db/types';

/**
 * Simplified transaction kinds (user redesign 2026-07-25): the stored
 * technical types stay the truth every reader consumes — the UI
 * collapses them into the choices a person actually makes:
 *
 * - standard    → income or expense, resolved by the money's sign
 * - transfer    → between two accounts munni tracks; the counterparty's
 *                 account type derives saving / debt payment / investment
 * - funding     → money to/from another SPACE's pot (user design
 *                 2026-08-01: the other side keeps its own books — no
 *                 counterparty, no cross-space references; the family
 *                 contribution case)
 * - adjustment  → a manual correction for an unresolvable discrepancy
 *
 * Money leaving to the outside world (a friend's IBAN, a shop) is
 * ALWAYS standard (user ruling): transfer is strictly between accounts
 * munni knows about.
 */
export type TxKind = 'standard' | 'transfer' | 'funding' | 'adjustment';

export const TX_KINDS: readonly TxKind[] = ['standard', 'transfer', 'funding', 'adjustment'];

/** the transfer family: which member is decided by the counterparty */
export const TRANSFER_TYPES: readonly TxType[] = ['transfer', 'saving', 'debtPayment', 'investment'];

export function kindOf(txType: TxType): TxKind {
  if (txType === 'adjustment') return 'adjustment';
  if (txType === 'funding') return 'funding';
  return TRANSFER_TYPES.includes(txType) ? 'transfer' : 'standard';
}

/** standard resolves by sign — negative money is an expense */
export const standardTypeFor = (amountCents: number): TxType => (amountCents < 0 ? 'expense' : 'income');
