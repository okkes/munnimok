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

// common NL place names as they appear behind merchant names on bank
// lines ("AH DELFT", "JUMBO S GRAVENHAGE") — only TRAILING tokens are
// stripped, so a merchant actually NAMED after a city ("Café Amsterdam"
// alone) keeps its identity through the leading tokens
const TRAILING_CITIES = new Set([
  'amsterdam', 'rotterdam', 'den haag', 's gravenhage', "'s gravenhage", "'s hertogenbosch", 'utrecht', 'eindhoven', 'tilburg', 'groningen',
  'almere', 'breda', 'nijmegen', 'enschede', 'haarlem', 'arnhem', 'zaandam', 'amersfoort', 'apeldoorn',
  's hertogenbosch', 'den bosch', 'hoofddorp', 'maastricht', 'leiden', 'dordrecht', 'zoetermeer', 'zwolle',
  'delft', 'alkmaar', 'leeuwarden', 'venlo', 'deventer', 'sittard', 'geleen', 'helmond', 'heerlen',
  'hilversum', 'amstelveen', 'purmerend', 'roosendaal', 'schiedam', 'spijkenisse', 'gouda', 'vlaardingen',
  'almelo', 'assen', 'veenendaal', 'katwijk', 'zeist', 'nieuwegein', 'ede', 'emmen', 'oss', 'rijswijk',
  'middelburg', 'diemen', 'hengelo', 'lelystad', 'duivendrecht',
]);

// #201 r2: banks spell the same city three ways ("S GRAVENHAGE",
// "SGRAVENHAGE", "'s gravenhage") — comparisons squash spacing and
// punctuation so every spelling strips identically
const squashCity = (value: string): string => value.replaceAll(/[^\p{L}]/gu, '');
const SQUASHED_CITIES = new Set([...TRAILING_CITIES].map(squashCity));

/** drops trailing city tokens: "albert heijn delft" → "albert heijn" */
function stripTrailingCity(value: string): string {
  const tokens = value.split(' ');
  // cities can be two tokens ("den haag") — try the longer match first
  while (tokens.length > 1) {
    const lastTwo = squashCity(tokens.slice(-2).join(' '));
    if (tokens.length > 2 && SQUASHED_CITIES.has(lastTwo)) {
      tokens.splice(-2, 2);
      continue;
    }
    if (SQUASHED_CITIES.has(squashCity(tokens.at(-1)!))) {
      tokens.pop();
      continue;
    }
    break;
  }
  return tokens.join(' ');
}

// #346: legal forms behind a name are spelled differently per bank line
// ("ODIDO NEDERLAND B.V." on one statement, "Odido Nederland BV" on the
// next) — trailing tokens only, one or two words after the punctuation
// collapse ("b v")
const LEGAL_FORMS = new Set(['bv', 'b v', 'nv', 'n v', 'vof', 'v o f', 'ltd', 'llc', 'inc', 'gmbh', 'plc', 'sarl']);

function stripLegalForms(value: string): string {
  const tokens = value.split(' ');
  while (tokens.length > 1) {
    if (tokens.length > 2 && LEGAL_FORMS.has(tokens.slice(-2).join(' '))) tokens.splice(-2, 2);
    else if (tokens.length > 3 && LEGAL_FORMS.has(tokens.slice(-3).join(' '))) tokens.splice(-3, 3);
    else if (LEGAL_FORMS.has(tokens.at(-1) ?? '')) tokens.pop();
    else break;
  }
  return tokens.join(' ');
}

export function merchantKey(merchant: string): string {
  const base = stripProcessorPrefix(merchant.toLowerCase().trim())
    // #450 (user): the date and the clock time of the charge are the one
    // thing that differs between two visits to the same till ("8.08.2026
    // 10U53", "11.09.2026 18U57"), and they come glued to the name as often
    // as not - a word boundary never caught "GRAVEN11.09.2026"
    .replaceAll(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g, ' ') // 8.08.2026, 11-09-26
    .replaceAll(/\d{4}-\d{2}-\d{2}/g, ' ') // 2026-09-11
    .replaceAll(/\d{1,2}[:uh.]\d{2}(?!\d)/g, ' ') // 10u53, 18:57, 9.05
    .replaceAll(/\d{2,}[\d./:-]*/g, ' ') // store nrs, terminal ids - glued to a word or not
    .replaceAll(/[^\p{L}\p{N}&' ]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  // branch cities differ per charge, the merchant doesn't (user request);
  // the legal form behind the name neither (#346)
  return stripLegalForms(stripTrailingCity(base)).slice(0, 40);
}
