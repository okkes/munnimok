import { describe, expect, it } from 'vitest';
import { isReferenceCode, merchantKey, merchantKeyBeforeBrands, merchantKeyBefore674 } from './merchantKey';

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
    expect(merchantKeyBeforeBrands('AH1470 Delft')).toBe('ah');
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
    expect(merchantKey('Kruidvat 2go 3')).toBe('kruidvat 2go');
  });

  it('#674 (user ss): an order code is no part of the name — every Amazon and bol.com charge is one merchant', () => {
    expect(merchantKeyBeforeBrands('WWW.AMAZON.* HF12S4JW5')).toBe('www amazon');
    expect(merchantKeyBeforeBrands('WWW.AMAZON.* H40FC73G5')).toBe('www amazon');
    expect(merchantKeyBeforeBrands('WWW.AMAZON.* 5O5AC6Y85')).toBe('www amazon');
    expect(merchantKeyBeforeBrands('AMZN Mktp NL*2A3B4C5D6')).toBe('amzn mktp nl');
    expect(merchantKey('bol.com C000KD5LPH')).toBe('bol com');
    // an IBAN in the line is a reference too
    expect(merchantKey('Incasso NL69INGB0123456789 Vattenfall')).toBe('incasso vattenfall');
    // before #674 each charge had a key of its own
    expect(merchantKeyBefore674('WWW.AMAZON.* HF12S4JW5')).not.toBe(merchantKeyBefore674('WWW.AMAZON.* H40FC73G5'));
  });

  it('#674: a name with a number in it is not a code — letters and digits must keep alternating', () => {
    expect(isReferenceCode('hf12s4jw5')).toBe(true);
    expect(isReferenceCode('ab1234cd')).toBe(true);
    for (const name of ['ah1470', 'car2go', 'fit4free', 'covid19test', 'windows11', '3fm', 'a1b2', '123456', 'amazon']) {
      expect(isReferenceCode(name)).toBe(false);
    }
    expect(merchantKey('car2go Deutschland')).toBe('car2go deutschland');
    expect(merchantKey('Fit4Free Rotterdam')).toBe('fit4free');
  });

  it('#674 (user): a supported shop is one merchant however the statement spells it', () => {
    const spelled: Record<string, string[]> = {
      amazon: [
        'WWW.AMAZON.* HF12S4JW5',
        'WWW.AMAZON.* HF12S4JW5 LUXEMBOURG LUX',
        'Amzn Mktp NL*AB1CD2EF3 LUXEMBOURG LUX',
        'Amzn Mktp NL*AB1CD2EF3 amazon.nl LUX',
        'AMZN Mktp NL',
        'AmazonRetail*AB1CD2EF3 www.amazon.nl LUX',
        'Amazon EU SARL',
        'Amazon Marketplace',
        'Amazon Payments Europe SCA',
        'Amazon.nl*AB1CD2EF3',
        'Amazon',
      ],
      'amazon prime': ['AMZNPRIMENL*AB1CD2EF3 LUXEMBOURG LUX', 'AmznPrimeNL*AB1CD2EF3 LUXEMBOURG LUX', 'Amazon Prime*AB1CD2EF3', 'AMZN Prime NL'],
      'albert heijn': [
        'ALBERT HEIJN 1234 UTRECHT NLD',
        'Albert Heijn 1576 S-GRAVENHAGE NLD',
        'Albert Heijn 1576 SGRAVENHAGE',
        'Albert Heijn B.V.',
        'BCK*Albertheijn Markt NLD',
        'AH to go 5823 Utrecht',
        'AH XL 1234 Eindhoven',
        'AH1470 Delft',
        'AH 1470 DELFT NLD',
      ],
      'bol com': ['bol.com C000KD5LPH Utrecht NLD', 'bol.com', 'bol.com b.v.', 'BOL', 'bol Utrecht NLD'],
      coolblue: ['Coolblue Rotterdam NLD', 'Coolblue B.V.'],
      jumbo: ['Jumbo Utrecht Stationsstr Utrecht NLD', 'Jumbo Stationsstraat UTRECHT NLD', 'Jumbo Supermarkten B.V.', 'CCV*Jumbo Foodmarkt'],
      lidl: ['Lidl 123 Delft NLD', 'LIDL NEDERLAND GMBH'],
      mediamarkt: ['MEDIAMARKT NL ROTTERDAM NLD', 'Media Markt Den Haag'],
    };
    for (const [key, lines] of Object.entries(spelled)) {
      for (const line of lines) expect(merchantKey(line), line).toBe(key);
    }
  });

  it('#674: a line that only begins like a shop keeps its own key', () => {
    // another business under the same name
    expect(merchantKey('Amazon Web Services EMEA')).toBe('amazon web services emea');
    expect(merchantKey('AMZN Digital*AB1CD2EF3')).toBe('amzn digital');
    expect(merchantKey('Amazon Prime Video*AB1CD2EF3')).toBe('amazon prime video');
    expect(merchantKey('Prime Video*AB1CD2EF3')).toBe('prime video');
    expect(merchantKey('Jumbo Golf Houten')).toBe('jumbo golf houten');
    // a short spelling needs to stand alone or before a place
    expect(merchantKey('AH Bouw B.V.')).toBe('ah bouw');
    expect(merchantKey('AH Vastgoed Delft')).toBe('ah vastgoed');
    expect(merchantKey('Bol Accountants')).toBe('bol accountants');
    // a longer word is another word
    expect(merchantKey('Amazonia Restaurant')).toBe('amazonia restaurant');
    expect(merchantKey('Lidlmaat Klusbedrijf')).toBe('lidlmaat klusbedrijf');
    expect(merchantKey('Jumbotron Events')).toBe('jumbotron events');
    // the shop's name further on in the line is a mention, not the merchant
    expect(merchantKey('Tikkie voor Jumbo boodschappen')).toBe('tikkie voor jumbo boodschappen');
  });

  it('keeps a name that merely ends in a look-alike word', () => {
    expect(merchantKey('BV')).toBe('bv');
    expect(merchantKey('Restaurant Inc Amsterdam')).toBe('restaurant');
  });
});
