import { describe, expect, it } from 'vitest';
import { cleanBankText } from './text';

describe('cleanBankText', () => {
  it('replaces <br> variants with a separator', () => {
    expect(cleanBankText('Incasso ING creditcard<br>Apple Pay')).toBe('Incasso ING creditcard · Apple Pay');
    expect(cleanBankText('a<BR>b<br/>c<br />d')).toBe('a · b · c · d');
  });

  it('strips other markup and collapses whitespace', () => {
    expect(cleanBankText('<b>Rente</b>   ING  Rood')).toBe('Rente ING Rood');
    expect(cleanBankText('  spaced   out  ')).toBe('spaced out');
  });

  it('keeps innocent text intact (incl. < in amounts)', () => {
    expect(cleanBankText('Albert Heijn 1842')).toBe('Albert Heijn 1842');
    expect(cleanBankText('a < b')).toBe('a < b'); // not a tag
  });

  it('handles empty and missing input', () => {
    expect(cleanBankText('')).toBe('');
    expect(cleanBankText(undefined)).toBe('');
  });
});
