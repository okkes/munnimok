import { describe, expect, it } from 'vitest';
import { predictCategory } from './predictCategory';
import { KEYWORD_RULES } from './keyword-categories';
import { CATEGORY_BY_ID } from './categories';

describe('predictCategory', () => {
  it('long keywords match as substrings, case-insensitive', () => {
    expect(predictCategory('ALBERT HEIJN 1350 AMSTERDAM', 'debit')).toBe('groceries');
    expect(predictCategory('betaling albert heijn', 'debit')).toBe('groceries');
  });

  it('short keywords (<=3 chars) must match a whole word', () => {
    // 'gvb' (public transport) fires as a word, never inside another word
    expect(predictCategory('gvb amsterdam', 'debit')).toBe('transportPublic');
    expect(predictCategory('MEGAGVBSTORE', 'debit')).not.toBe('transportPublic');
  });

  it('direction filters rules (income keywords never fire on debits)', () => {
    expect(predictCategory('salaris juni', 'credit')).toBe('salary');
    expect(predictCategory('salaris juni', 'debit')).not.toBe('salary');
  });

  it('longest keyword wins over shorter overlapping ones', () => {
    // construct text hitting both a long and a short rule; long is checked first
    const withLong = predictCategory('albert heijn to go', 'debit');
    expect(withLong).toBe('groceries');
  });

  it('returns null when nothing matches', () => {
    expect(predictCategory('xqzzy unmatched merchant', 'debit')).toBeNull();
    expect(predictCategory('', 'credit')).toBeNull();
  });

  it('every rule points at an existing catalog category (generated data integrity)', () => {
    for (const rule of KEYWORD_RULES) {
      expect(CATEGORY_BY_ID.get(rule.catId), rule.catId).toBeTruthy();
      expect(rule.keywords.length).toBeGreaterThan(0);
    }
  });
});
