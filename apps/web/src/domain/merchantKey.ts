/**
 * Normalizes a bank counterparty string into a stable key, so the same
 * merchant matches across statements and devices: payment-processor
 * prefixes go (CCV*, Zettle_*, SumUp*, PayPal*), store/terminal numbers
 * and dates go, punctuation collapses. "CCV*ALBERT HEIJN 1470 AMS" and
 * "Albert Heijn 1470" both become "albert heijn …".
 */
const PROCESSOR_PREFIX = /^(ccv\s*\*?|zettle[_\s]\*?|sumup\s*\*?|payl\.|ideal\s+|paypal\s*\*?|bck\s*\*?|sepa\s+)/i;

export function merchantKey(merchant: string): string {
  return merchant
    .toLowerCase()
    .trim()
    .replace(PROCESSOR_PREFIX, '')
    .replaceAll(/\b\d{2,}[\d./:-]*\b/g, ' ') // store nrs, dates, terminal ids
    .replaceAll(/[^\p{L}\p{N}&' ]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
