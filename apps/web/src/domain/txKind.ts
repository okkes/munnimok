import type { TxType } from '@/db/types';

/**
 * Simplified transaction kinds (user redesign 2026-07-25): the SEVEN
 * technical types stay the stored truth every reader consumes — the UI
 * collapses them into three choices a person actually makes:
 *
 * - standard    → income or expense, resolved by the money's sign
 * - transfer    → between two accounts munni tracks; the counterparty's
 *                 account type derives saving / debt payment / investment
 * - adjustment  → a manual correction for an unresolvable discrepancy
 *
 * Money leaving to the outside world (a friend's IBAN, a shop) is
 * ALWAYS standard (user ruling): transfer is strictly between accounts
 * munni knows about.
 */
export type TxKind = 'standard' | 'transfer' | 'adjustment';

export const TX_KINDS: readonly TxKind[] = ['standard', 'transfer', 'adjustment'];

/** the transfer family: which member is decided by the counterparty */
export const TRANSFER_TYPES: readonly TxType[] = ['transfer', 'saving', 'debtPayment', 'investment'];

export function kindOf(txType: TxType): TxKind {
  if (txType === 'adjustment') return 'adjustment';
  return TRANSFER_TYPES.includes(txType) ? 'transfer' : 'standard';
}

/** standard resolves by sign — negative money is an expense */
export const standardTypeFor = (amountCents: number): TxType => (amountCents < 0 ? 'expense' : 'income');
