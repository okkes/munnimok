import { CATEGORY_BY_ID } from './categories';
import { KEYWORD_RULES } from './keyword-categories';

/**
 * Keyword-based category prediction for imported bank transactions, ported
 * from apollousa's CategoryByKeyWordPredictor. Runs fully on-device so
 * import works offline.
 *
 * Long keywords (>3 chars) match as substrings; short ones must match a
 * whole word. Longest keyword wins. Rules are filtered by money direction
 * so e.g. income keywords never fire on a debit.
 */
export function predictCategory(text: string, direction: 'credit' | 'debit'): string | null {
  const haystack = text.toLowerCase();
  const words = new Set(haystack.split(/\s+/));

  const candidates: { keyword: string; catId: string }[] = [];
  for (const rule of KEYWORD_RULES) {
    const cat = CATEGORY_BY_ID.get(rule.catId);
    if (!cat) continue;
    if (cat.direction !== 'both' && cat.direction !== direction) continue;
    for (const keyword of rule.keywords) candidates.push({ keyword, catId: rule.catId });
  }
  candidates.sort((a, b) => b.keyword.length - a.keyword.length);

  for (const { keyword, catId } of candidates) {
    const hit = keyword.length > 3 ? haystack.includes(keyword) : words.has(keyword);
    if (hit) return catId;
  }
  return null;
}
