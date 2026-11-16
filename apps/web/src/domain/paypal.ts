import { normalizeIban } from './feedIds';
import { merchantKey } from './merchantKey';

// a PayPal purchase shows twice: a bank debit (a SHARED collection IBAN, never identifying the user) and the PayPal-feed row
// PP1 rule: count once on the PayPal side, the bank debit becomes a transfer to the PayPal account; any funding account

/** PayPal Europe's known SEPA collection IBANs (shared across customers) */
const PAYPAL_COLLECTION_IBANS = new Set(['LU89751000135104200E', 'LU096375100013510420']);

const PAYPAL_NAME = /\bpay\s?pal\b/i;

export function isPaypalFunding(tx: { merchant: string; counterIban?: string; description?: string }): boolean {
  if (PAYPAL_NAME.test(tx.merchant)) return true;
  if (tx.counterIban && PAYPAL_COLLECTION_IBANS.has(normalizeIban(tx.counterIban))) return true;
  return false;
}

export function isPaypalAccount(account: { name: string; bankId?: string }): boolean {
  return PAYPAL_NAME.test(account.name) || /paypal/i.test(account.bankId ?? '');
}

const DAY_MS = 86_400_000;
const dayDistance = (a: string, b: string): number => Math.abs(Date.parse(a) - Date.parse(b)) / DAY_MS;

export interface PaypalPairInput {
  id: string;
  date: string;
  amountCents: number;
  merchant: string;
  description?: string;
}

// an unresolvable tie pairs nothing: those rows stay review-gated rather than guessing
export function matchPaypalPairs(
  bankDebits: readonly PaypalPairInput[],
  paypalTxs: readonly PaypalPairInput[],
  windowDays = 3,
): Map<string, string> {
  const pairs = new Map<string, string>();
  const taken = new Set<string>();
  for (const debit of bankDebits) {
    const bankText = `${debit.merchant} ${debit.description ?? ''}`.toLowerCase();
    const candidates = paypalTxs
      .filter(
        (p) =>
          !taken.has(p.id) &&
          Math.abs(p.amountCents) === Math.abs(debit.amountCents) &&
          dayDistance(p.date, debit.date) <= windowDays,
      )
      .sort((a, b) => dayDistance(a.date, debit.date) - dayDistance(b.date, debit.date));
    if (candidates.length === 0) continue;
    let pick = candidates[0];
    if (candidates.length > 1) {
      const tokenHits = candidates.filter((p) => bankText.includes(merchantKey(p.merchant)));
      if (tokenHits.length !== 1) continue;
      pick = tokenHits[0];
    }
    pairs.set(debit.id, pick.id);
    taken.add(pick.id);
  }
  return pairs;
}
