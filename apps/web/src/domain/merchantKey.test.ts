import { describe, expect, it } from 'vitest';
import { merchantKey } from './merchantKey';

describe('merchantKey', () => {
  it('#346: the legal form behind a name is noise — B.V., BV and N.V. spell the same merchant', () => {
    expect(merchantKey('ODIDO NEDERLAND B.V.')).toBe('odido nederland');
    expect(merchantKey('Odido Nederland BV')).toBe('odido nederland');
    expect(merchantKey('ENECO SERVICES N.V. ROTTERDAM')).toBe('eneco services');
    expect(merchantKey('Acme Holdings Ltd')).toBe('acme holdings');
  });

  it('#450 (user): the date and the clock time of a charge are noise, glued to the name or not', () => {
    // the same till on two days, as the bank spells it - the second has no space before the date
    expect(merchantKey("SEN MARKET >'S-GRAVEN 8.08.2026 10U53 KV")).toBe("sen market 's graven kv");
    expect(merchantKey("SEN MARKET >'S-GRAVEN11.09.2026 18U57 KV")).toBe("sen market 's graven kv");
    expect(merchantKey('Bakkerij Jansen 2026-09-11 18:57')).toBe('bakkerij jansen');
    expect(merchantKey('AH1470 Delft')).toBe('ah');
    // a single digit that is part of the name stays
    expect(merchantKey('Radio 3FM shop')).toBe('radio 3fm shop');
  });

  it('keeps a name that merely ends in a look-alike word', () => {
    expect(merchantKey('BV')).toBe('bv');
    expect(merchantKey('Restaurant Inc Amsterdam')).toBe('restaurant');
  });
});
