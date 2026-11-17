import { normalizeIban } from './feedIds';
import { isPaypalAccount, isPaypalFunding } from './paypal';
import type { AccountType } from '@/db/types';

// #228 r3: never lean an AUTOMATIC transfer on the default account: a transfer needs a clue naming a tracked account,
// else the caller stands down to uncategorized. Signals: counter IBAN equality, PayPal funding, a distinctive name token.
// Deterministic (ids break ties) so two devices converge.

export interface ClueTx {
  merchant: string;
  titleOverride?: string;
  description?: string;
  counterIban?: string;
}

export interface ClueAccount {
  id: string;
  name: string;
  type: AccountType;
  iban?: string;
  bankId?: string;
  defaultFor?: string;
  archived?: 0 | 1;
}

/** generic words and email hosts: an account named "Savings account" must not claim every row saying "savings" */
const NOISE_TOKENS = new Set([
  'bank', 'account', 'accounts', 'card', 'cards', 'cash', 'credit', 'debit',
  'checking', 'current', 'savings', 'saving', 'wallet', 'joint', 'shared',
  'main', 'primary', 'default', 'giro', 'depot', 'fund', 'funds',
  'rekening', 'betaalrekening', 'spaarrekening', 'lopende', 'spaar', 'sparen',
  'kaart', 'krediet', 'gezamenlijk', 'gedeeld', 'portemonnee',
  'hesap', 'hesabi', 'banka', 'kart', 'nakit', 'ortak', 'birikim',
  'gmail', 'hotmail', 'outlook', 'live', 'yahoo', 'icloud', 'mail', 'email',
]);

/** ≥4 chars, carries at least one letter, not a generic word */
const tokensOf = (name: string): string[] =>
  name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 4 && /[a-z]/.test(token) && !NOISE_TOKENS.has(token));

const PAYPAL_SIGNAL_STRENGTH = 6; // as strong as the brand token itself

function clueStrength(account: ClueAccount, haystack: string, paypalRow: boolean): number {
  let strength = paypalRow && isPaypalAccount(account) ? PAYPAL_SIGNAL_STRENGTH : 0;
  for (const token of tokensOf(account.name)) {
    if (token.length > strength && haystack.includes(token)) strength = token.length;
  }
  return strength;
}

export function matchCounterAccount<A extends ClueAccount>(
  tx: ClueTx,
  accounts: readonly A[],
  excludeAccountId?: string,
): A | undefined {
  const candidates = accounts
    .filter((a) => a.id !== excludeAccountId && !a.defaultFor && a.archived !== 1)
    .sort((a, b) => a.id.localeCompare(b.id));
  if (candidates.length === 0) return undefined;

  const counterIban = tx.counterIban ? normalizeIban(tx.counterIban) : undefined;
  if (counterIban) {
    const byIban = candidates.find((a) => a.iban && normalizeIban(a.iban) === counterIban);
    if (byIban) return byIban;
  }

  const haystack = `${tx.merchant} ${tx.titleOverride ?? ''} ${tx.description ?? ''}`.toLowerCase();
  const paypalRow = isPaypalFunding(tx);
  let best: A | undefined;
  let bestStrength = 0;
  for (const account of candidates) {
    const strength = clueStrength(account, haystack, paypalRow);
    if (strength > bestStrength) {
      best = account;
      bestStrength = strength;
    }
  }
  return best;
}
