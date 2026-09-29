import { describe, expect, it } from 'vitest';
import { merchantKey } from './merchantKey';

describe('merchantKey', () => {
  it('#346: the legal form behind a name is noise — B.V., BV and N.V. spell the same merchant', () => {
    expect(merchantKey('ODIDO NEDERLAND B.V.')).toBe('odido nederland');
    expect(merchantKey('Odido Nederland BV')).toBe('odido nederland');
    expect(merchantKey('ENECO SERVICES N.V. ROTTERDAM')).toBe('eneco services');
    expect(merchantKey('Acme Holdings Ltd')).toBe('acme holdings');
  });

  it('keeps a name that merely ends in a look-alike word', () => {
    expect(merchantKey('BV')).toBe('bv');
    expect(merchantKey('Restaurant Inc Amsterdam')).toBe('restaurant');
  });
});
