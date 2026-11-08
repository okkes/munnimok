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
    expect(merchantKey("SEN MARKET >'S-GRAVEN 8.08.2026 10U53 KV")).toBe('sen market');
    expect(merchantKey("SEN MARKET >'S-GRAVEN11.09.2026 18U57 KV")).toBe('sen market');
    expect(merchantKey('Bakkerij Jansen 2026-09-11 18:57')).toBe('bakkerij jansen');
    expect(merchantKey('AH1470 Delft')).toBe('ah');
    // a single digit that is part of the name stays
    expect(merchantKey('Radio 3FM shop')).toBe('radio 3fm shop');
  });

  it('#578 (user ss): every Albert Heijn card line is the same merchant, whatever the till, the day or the forty-character cut left', () => {
    // the feed's titles: the description cut to forty characters, the last digit a sliver of the time
    const lines = [
      'Albert Heijn 1842 >S-GRAVENH30.10.2026 1',
      'Albert Heijn 1842 >S-GRAVENH02.11.2026 2',
      'Albert Heijn 1842     >S-GRAVENH 2.04.2026 21U15 KV007 MCC:5411 Apple Pay betaling   NLNEDERLAND',
      'Albert Heijn 1842 >S-GRAVENH30.10.2026 18U08 KV007 BS158817 MCC:5411 Apple Pay betaling NLNEDERLAND',
      'Albert Heijn 1470 >DELFT 12.10.2026 09U41 KV004',
      'ALBERT HEIJN 1473 S GRAVENHAGE',
      'Albert Heijn 1842',
    ];
    expect(new Set(lines.map(merchantKey))).toEqual(new Set(['albert heijn']));
    // a line that is nothing but place keeps its text rather than going blank
    expect(merchantKey('>S-GRAVENH30.10.2026')).toBe('s gravenh');
    // a lone digit standing on its own is noise; glued to a word it is the name
    expect(merchantKey('Kruidvat 2go 3')).toBe('kruidvat 2go');
  });

  it('keeps a name that merely ends in a look-alike word', () => {
    expect(merchantKey('BV')).toBe('bv');
    expect(merchantKey('Restaurant Inc Amsterdam')).toBe('restaurant');
  });
});
