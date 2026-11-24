import { describe, expect, it } from 'vitest';
import { detectPriceChange, priceChangeTold, priceUpdateWaits, yearlyCents, yearlyDeltaCents } from './recurringPrice';

const charge = (date: string, cents: number) => ({ date, amountCents: -cents });

describe('detectPriceChange', () => {
  it('fires on a sustained increase and reports since when it started', () => {
    const change = detectPriceChange([
      charge('2026-01-05', 1399),
      charge('2026-02-05', 1399),
      charge('2026-03-05', 1599),
      charge('2026-04-05', 1599),
    ]);
    expect(change).toEqual({ fromCents: 1399, toCents: 1599, sinceDate: '2026-03-05', chargesSince: 2 });
  });

  it('#682: a one-off charge is no price to have changed from — back at the usual amount is no change', () => {
    // a deductible billed once between two ordinary months
    expect(
      detectPriceChange([charge('2026-08-27', 15000), charge('2026-09-09', 32000), charge('2026-09-28', 15000), charge('2026-10-27', 15000)]),
    ).toBeNull();
    expect(
      detectPriceChange([
        charge('2026-06-27', 15000),
        charge('2026-07-27', 15000),
        charge('2026-08-09', 32000),
        charge('2026-08-27', 15000),
        charge('2026-09-27', 15000),
      ]),
    ).toBeNull();
    // the one-off sits between two real prices: the change is from the price before it
    expect(
      detectPriceChange([
        charge('2026-06-27', 15000),
        charge('2026-07-27', 15000),
        charge('2026-08-09', 32000),
        charge('2026-08-27', 16000),
        charge('2026-09-27', 16000),
      ]),
    ).toEqual({ fromCents: 15000, toCents: 16000, sinceDate: '2026-08-27', chargesSince: 2 });
    // two earlier charges that agree on nothing say nothing about the old price
    expect(detectPriceChange([charge('2026-07-27', 15000), charge('2026-08-09', 32000), charge('2026-08-27', 16000), charge('2026-09-27', 16000)])).toBeNull();
  });

  it('#682: a change is told while the cost’s own amount waits for it, and for its first three charges — then the new price is the price', () => {
    const months = (n: number) => [
      charge('2026-01-11', 2599),
      charge('2026-02-11', 2599),
      ...Array.from({ length: n }, (_, at) => charge(`2026-${String(at + 3).padStart(2, '0')}-11`, 2999)),
    ];
    const fresh = detectPriceChange(months(2));
    const settled = detectPriceChange(months(4));
    expect(fresh?.chargesSince).toBe(2);
    expect(settled?.chargesSince).toBe(4);

    // the amount was never updated: both screens keep asking, however long ago
    expect(priceUpdateWaits({ amountCents: 2599 }, settled)).toBe(true);
    expect(priceChangeTold({ amountCents: 2599 }, settled)).toBe(true);
    // updated: nothing waits; the cost's own screen still tells it while it is news
    expect(priceUpdateWaits({ amountCents: 2999 }, fresh)).toBe(false);
    expect(priceChangeTold({ amountCents: 2999 }, fresh)).toBe(true);
    expect(priceChangeTold({ amountCents: 2999 }, detectPriceChange(months(3)))).toBe(true);
    expect(priceChangeTold({ amountCents: 2999 }, settled)).toBe(false);
    expect(priceChangeTold({ amountCents: 2999 }, null)).toBe(false);
  });

  it('a one-off different charge (proration) stays silent', () => {
    expect(
      detectPriceChange([charge('2026-01-05', 1399), charge('2026-02-05', 899), charge('2026-03-05', 1399)]),
    ).toBeNull();
    expect(
      detectPriceChange([charge('2026-01-05', 1399), charge('2026-02-05', 1399), charge('2026-03-05', 1599)]),
    ).toBeNull();
  });

  it('needs history: constant prices and short histories stay silent', () => {
    expect(detectPriceChange([charge('2026-01-05', 999), charge('2026-02-05', 999), charge('2026-03-05', 999)])).toBeNull();
    expect(detectPriceChange([charge('2026-01-05', 999), charge('2026-02-05', 1099)])).toBeNull();
  });

  it('detects decreases too and ignores credits/order', () => {
    const change = detectPriceChange([
      charge('2026-03-05', 899),
      { date: '2026-02-20', amountCents: 500 },
      charge('2026-01-05', 1099),
      charge('2026-04-05', 899),
    ]);
    expect(change).toEqual({ fromCents: 1099, toCents: 899, sinceDate: '2026-03-05', chargesSince: 2 });
  });
});

describe('yearly math', () => {
  it('annualizes monthly, yearly and n-weekly cadences', () => {
    expect(yearlyCents({ amountCents: 1000, every: 'month' })).toBe(12000);
    expect(yearlyCents({ amountCents: 12000, every: 'year' })).toBe(12000);
    expect(yearlyCents({ amountCents: 1000, every: 'month', everyN: 3 })).toBe(4000);
    // weekly ≈ 52.14 charges a year
    expect(yearlyCents({ amountCents: 1000, every: 'week' })).toBe(52140);
  });

  it('expresses a change as yearly impact', () => {
    expect(yearlyDeltaCents({ every: 'month' }, { fromCents: 1399, toCents: 1599, sinceDate: 'x', chargesSince: 2 })).toBe(2400);
    expect(yearlyDeltaCents({ every: 'year' }, { fromCents: 10000, toCents: 9000, sinceDate: 'x', chargesSince: 2 })).toBe(-1000);
  });
});
