import { describe, expect, it } from 'vitest';
import { interpolate } from './index';

describe('interpolate — the translator’s slots', () => {
  it('fills the named slots and leaves unknown ones as written', () => {
    expect(interpolate('Fetched by munni from {party}', { party: 'GoCardless' })).toBe('Fetched by munni from GoCardless');
    expect(interpolate('{n} new receipts', { n: 3 })).toBe('3 new receipts');
    expect(interpolate('{what} stays', {})).toBe('{what} stays');
    expect(interpolate('plain')).toBe('plain');
  });

  it('yields nothing for a template that is not a string, instead of taking the screen down (prod ss 2026-10-04)', () => {
    // a lookup table fed a value this build no longer lists hands the translator an undefined key
    expect(interpolate(undefined as unknown as string, { party: 'GoCardless' })).toBe('');
    expect(interpolate(undefined as unknown as string)).toBe('');
  });
});
