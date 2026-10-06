import { describe, expect, it } from 'vitest';
import { hrefOf, parseHash } from './router';

describe('the hash router', () => {
  it('splits the hash into decoded segments; the empty hash is the dashboard', () => {
    expect(parseHash('')).toEqual([]);
    expect(parseHash('#/')).toEqual([]);
    expect(parseHash('#/providers')).toEqual(['providers']);
    expect(parseHash('#/providers/mock%2Dstore')).toEqual(['providers', 'mock-store']);
    expect(parseHash('#providers//ah/')).toEqual(['providers', 'ah']);
  });

  it('hrefOf writes a hash route without doubling the slash', () => {
    expect(hrefOf('')).toBe('#/');
    expect(hrefOf('providers')).toBe('#/providers');
    expect(hrefOf('/providers/ah')).toBe('#/providers/ah');
  });
});
