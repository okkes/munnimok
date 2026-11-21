/**
 * #674: a shop the statement spells several ways is one merchant — "Amzn Mktp NL", "WWW.AMAZON.*" and "Amazon EU SARL";
 * "Albert Heijn 1234 Utrecht NLD" and "BCK*Albertheijn". The shops are the ones munni reads receipts from. A spelling is
 * how a line STARTS, in the words merchantKey leaves; what follows is the branch, the street or the country and is no
 * part of the name. It is a list on purpose: a line that fits no spelling keeps its own key, and no model guesses.
 */
interface Brand {
  /** the key every spelling lands on */
  key: string;
  /** starts that name the shop whatever follows */
  starts: readonly string[];
  /** starts too short to name the shop with any word behind them ("ah bouw"): alone, or followed by a place only */
  bare?: readonly string[];
  /** the word after a start when the line is another business under the same name ("amazon web services") */
  apart?: readonly string[];
}

const BRANDS: readonly Brand[] = [
  { key: 'albert heijn', starts: ['albert heijn', 'albertheijn', 'ah to go', 'ah xl'], bare: ['ah'] },
  // the subscription and the cloud are charged under the same name and are no purchase at the shop
  { key: 'amazon', starts: ['amazon', 'amzn', 'www amazon', 'amazonretail'], apart: ['prime', 'web', 'music', 'video', 'digital', 'kindle'] },
  { key: 'amazon prime', starts: ['amazon prime', 'amzn prime', 'amznprime', 'amznprimenl'], apart: ['video'] },
  { key: 'bol com', starts: ['bol com'], bare: ['bol'] },
  { key: 'coolblue', starts: ['coolblue'] },
  { key: 'jumbo', starts: ['jumbo'], apart: ['golf'] },
  { key: 'lidl', starts: ['lidl'] },
  { key: 'mediamarkt', starts: ['mediamarkt', 'media markt'] },
];

interface Spelled {
  key: string;
  starts: string[][];
  bare: string[][];
  apart: ReadonlySet<string>;
}

const words = (spelling: string): string[] => spelling.split(' ');

const SPELLED: readonly Spelled[] = BRANDS.map((brand) => ({
  key: brand.key,
  starts: brand.starts.map(words),
  bare: (brand.bare ?? []).map(words),
  apart: new Set(brand.apart ?? []),
}));

/** the words behind a start, or null when the line does not begin with it */
function restAfter(line: readonly string[], start: readonly string[]): string[] | null {
  if (start.length > line.length || !start.every((word, at) => line[at] === word)) return null;
  return line.slice(start.length);
}

/** how many words of the line the brand's longest fitting spelling takes; 0 when the line is not this brand's */
function wordsTaken(brand: Spelled, line: readonly string[], isPlace: (rest: readonly string[]) => boolean): number {
  let taken = 0;
  for (const start of brand.starts) {
    const rest = restAfter(line, start);
    if (rest && !brand.apart.has(rest[0] ?? '')) taken = Math.max(taken, start.length);
  }
  for (const start of brand.bare) {
    const rest = restAfter(line, start);
    if (rest && isPlace(rest)) taken = Math.max(taken, start.length);
  }
  return taken;
}

/**
 * the brand a normalized merchant line belongs to, or null. `isPlace` says whether the words behind a bare start are
 * nothing but a place (merchantKey owns the cities)
 */
export function brandKey(normalized: string, isPlace: (rest: readonly string[]) => boolean): string | null {
  if (!normalized) return null;
  const line = words(normalized);
  let best: { key: string; taken: number } | null = null;
  for (const brand of SPELLED) {
    const taken = wordsTaken(brand, line, isPlace);
    if (taken > (best?.taken ?? 0)) best = { key: brand.key, taken };
  }
  return best?.key ?? null;
}
