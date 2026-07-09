/**
 * Normalizes a bank counterparty string into a stable key, so the same
 * merchant matches across statements and devices: payment-processor
 * prefixes go (CCV*, Zettle_*, SumUp*, PayPal*), store/terminal numbers
 * and dates go, punctuation collapses. "CCV*ALBERT HEIJN 1470 AMS" and
 * "Albert Heijn 1470" both become "albert heijn …".
 */
const PROCESSOR_PREFIXES = ['ccv', 'zettle', 'sumup', 'payl.', 'ideal', 'paypal', 'bck', 'sepa'];

/** drops a leading payment-processor tag ("ccv*", "zettle_", "sepa ") */
function stripProcessorPrefix(value: string): string {
  for (const prefix of PROCESSOR_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const rest = value.slice(prefix.length);
    // a real tag is followed by a separator — "separate" is not "sepa"
    if (prefix.endsWith('.') || /^[\s_*.]/.test(rest)) return rest.replace(/^[\s_*.]+/, '');
  }
  return value;
}

export function merchantKey(merchant: string): string {
  return stripProcessorPrefix(merchant.toLowerCase().trim())
    .replaceAll(/\b\d{2,}[\d./:-]*/g, ' ') // store nrs, dates, terminal ids
    .replaceAll(/[^\p{L}\p{N}&' ]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
}
