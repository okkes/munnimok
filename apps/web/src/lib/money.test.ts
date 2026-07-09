import { describe, expect, it } from 'vitest';
import { fmtCents, parseCents } from './money';

describe('parseCents (user input -> integer cents)', () => {
  it('parses EU format (comma decimal, dot thousands)', () => {
    expect(parseCents('12,50')).toBe(1250);
    expect(parseCents('1.234,56')).toBe(123456);
    expect(parseCents('0,01')).toBe(1);
    expect(parseCents('1.000.000,00')).toBe(100000000);
  });

  it('parses plain and dot-decimal input', () => {
    expect(parseCents('12.50')).toBe(1250);
    expect(parseCents('1234')).toBe(123400);
    expect(parseCents('0')).toBe(0);
  });

  it('trims whitespace and rejects garbage', () => {
    expect(parseCents(' 12,50 ')).toBe(1250);
    expect(parseCents('')).toBeNull();
    expect(parseCents('abc')).toBeNull();
    expect(parseCents('12,5x')).toBeNull();
    expect(parseCents('1,2,3')).toBeNull();
  });

  it('never produces fractional cents', () => {
    expect(parseCents('0,005')).toBe(1); // rounds, stays integer
    expect(Number.isInteger(parseCents('123,456')!)).toBe(true);
  });
});

describe('fmtCents (integer cents -> localized string)', () => {
  it('formats per language locale', () => {
    expect(fmtCents(123456, 'EUR', 'en')).toBe('€1,234.56');
    expect(fmtCents(123456, 'EUR', 'nl')).toBe('€ 1.234,56');
    expect(fmtCents(-2899, 'EUR', 'en')).toBe('-€28.99');
  });

  it('adds an explicit plus sign only when asked and positive', () => {
    expect(fmtCents(2000, 'EUR', 'en', { sign: true })).toBe('+€20.00');
    expect(fmtCents(-2000, 'EUR', 'en', { sign: true })).toBe('-€20.00');
    expect(fmtCents(0, 'EUR', 'en', { sign: true })).toBe('€0.00');
    expect(fmtCents(2000, 'EUR', 'en')).toBe('€20.00');
  });

  it('handles non-euro currencies', () => {
    expect(fmtCents(123456, 'TRY', 'tr')).toContain('1.234,56');
    expect(fmtCents(100, 'GBP', 'en')).toBe('£1.00');
  });
});
