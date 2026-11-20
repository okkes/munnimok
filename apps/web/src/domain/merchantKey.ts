import { brandKey } from './merchantBrands';

/** same merchant, same key across statements and devices: processor prefixes, store/terminal numbers and dates go */
const PROCESSOR_PREFIXES = ['ccv', 'zettle', 'sumup', 'payl.', 'ideal', 'paypal', 'bck', 'sepa'];

function stripProcessorPrefix(value: string): string {
  for (const prefix of PROCESSOR_PREFIXES) {
    if (!value.startsWith(prefix)) continue;
    const rest = value.slice(prefix.length);
    // a real tag is followed by a separator — "separate" is not "sepa"
    if (prefix.endsWith('.') || /^[\s_*.]/.test(rest)) return rest.replace(/^[\s_*.]+/, '');
  }
  return value;
}

// only TRAILING city tokens strip, so a merchant named after a city ("Café Amsterdam" alone) keeps its identity
const TRAILING_CITIES = new Set([
  'amsterdam', 'rotterdam', 'den haag', 's gravenhage', "'s gravenhage", "'s hertogenbosch", 'utrecht', 'eindhoven', 'tilburg', 'groningen',
  'almere', 'breda', 'nijmegen', 'enschede', 'haarlem', 'arnhem', 'zaandam', 'amersfoort', 'apeldoorn',
  's hertogenbosch', 'den bosch', 'hoofddorp', 'maastricht', 'leiden', 'dordrecht', 'zoetermeer', 'zwolle',
  'delft', 'alkmaar', 'leeuwarden', 'venlo', 'deventer', 'sittard', 'geleen', 'helmond', 'heerlen',
  'hilversum', 'amstelveen', 'purmerend', 'roosendaal', 'schiedam', 'spijkenisse', 'gouda', 'vlaardingen',
  'almelo', 'assen', 'veenendaal', 'katwijk', 'zeist', 'nieuwegein', 'ede', 'emmen', 'oss', 'rijswijk',
  'middelburg', 'diemen', 'hengelo', 'lelystad', 'duivendrecht',
]);

// #201: banks spell one city several ways ("S GRAVENHAGE", "SGRAVENHAGE", "'s gravenhage"): compare squashed
const squashCity = (value: string): string => value.replaceAll(/[^\p{L}]/gu, '');
const SQUASHED_CITIES = new Set([...TRAILING_CITIES].map(squashCity));

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

// a card line closes with the country it was paid in ("DELFT NLD"); the shops with a bare spelling trade in these two
const CARD_COUNTRIES = new Set(['nld', 'bel']);

/** nothing but a place: a city this list knows, a country code behind it, or both */
function isPlace(rest: readonly string[]): boolean {
  const city = CARD_COUNTRIES.has(rest.at(-1) ?? '') ? rest.slice(0, -1) : rest;
  return city.length === 0 || SQUASHED_CITIES.has(squashCity(city.join(' ')));
}

// #346: legal forms are spelled differently per bank line ("B.V." vs "BV"): trailing tokens only, one or two words ("b v")
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

// #578: ING card lines put the place behind ">" and the feed cuts them at forty characters; the name stands before it
// a line that is nothing but place keeps its text
function cutAtPlaceMarker(value: string): string {
  const at = value.indexOf('>');
  if (at <= 0) return value;
  const head = value.slice(0, at);
  return /\p{L}/u.test(head) ? head : value;
}

// #674: an order or reference code differs per charge and is no part of the name ("WWW.AMAZON.* HF12S4JW5",
// "bol.com C000KD5LPH", an IBAN). A run of letters and digits is one when the two keep alternating: three switches or
// more, or two around four digits or more. A name with a number in it switches once or twice ("ah1470", "car2go")
export function isReferenceCode(run: string): boolean {
  if (run.length < 6) return false;
  let switches = 0;
  let digits = 0;
  let previous: 'digit' | 'letter' | null = null;
  for (const char of run) {
    const kind = char >= '0' && char <= '9' ? 'digit' : 'letter';
    if (kind === 'digit') digits++;
    if (previous && previous !== kind) switches++;
    previous = kind;
  }
  return switches >= 3 || (switches === 2 && digits >= 4);
}

const dropReferenceCodes = (value: string): string => value.replaceAll(/[\p{L}\p{N}]+/gu, (run) => (isReferenceCode(run) ? ' ' : run));

/** the spellings a key has had: stored keys of an older one are moved once (application/merchantKeyRekey.ts) */
type Spelling = 577 | 673 | 674;

function normalize(merchant: string, spelling: Spelling): string {
  const since578 = spelling >= 673;
  const lowered = merchant.toLowerCase().trim();
  const named = stripProcessorPrefix(since578 ? cutAtPlaceMarker(lowered) : lowered);
  const cleaned = (spelling >= 674 ? dropReferenceCodes(named) : named)
    // #450: date and time differ between visits to the same till and come glued to the name, which a word boundary never caught
    .replaceAll(/\d{1,2}[./-]\d{1,2}[./-]\d{2,4}/g, ' ') // 8.08.2026, 11-09-26
    .replaceAll(/\d{4}-\d{2}-\d{2}/g, ' ') // 2026-09-11
    .replaceAll(/\d{1,2}[:uh.]\d{2}(?!\d)/g, ' ') // 10u53, 18:57, 9.05
    .replaceAll(/\d{2,}[\d./:-]*/g, ' ') // store nrs, terminal ids - glued to a word or not
    .replaceAll(/[^\p{L}\p{N}&' ]+/gu, ' ');
  // #578: a lone digit is what the forty-character cut left of a time or
  // a store number ("…30.10.2026 1") - glued to a word ("3fm") it stays
  const base = (since578 ? cleaned.replaceAll(/(?<=^|\s)\d(?=\s|$)/g, ' ') : cleaned).replaceAll(/\s+/g, ' ').trim();
  // branch cities and legal forms (#346) differ per charge; the merchant doesn't
  return stripLegalForms(stripTrailingCity(base)).slice(0, 40);
}

export function merchantKey(merchant: string): string {
  const spelled = normalize(merchant, 674);
  return brandKey(spelled, isPlace) ?? spelled;
}

/** the key as spelled before the brand list, before #674 and before #578; read only by the stored-key migration (application/merchantKeyRekey.ts) */
export function merchantKeyBeforeBrands(merchant: string): string {
  return normalize(merchant, 674);
}

export function merchantKeyBefore674(merchant: string): string {
  return normalize(merchant, 673);
}

export function merchantKeyBefore578(merchant: string): string {
  return normalize(merchant, 577);
}
