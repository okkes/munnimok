import { describe, expect, it } from 'vitest';
import { pairReservedWithBooked, twinScore } from './reservedTwin';

const row = (id: string, date: string, amountCents: number, merchant: string) => ({ id, date, amountCents, merchant });

describe('the booked twin of a reserved charge (#533)', () => {
  it('the same payment booked a day later is the twin; a different hold amount still is when the merchant agrees', () => {
    const hold = row('r', '2026-10-06', -1300, 'PAY.nl*X TU DELFT');
    expect(twinScore(hold, row('b', '2026-10-07', -1300, 'PAY.nl*X TU DELFT'))).not.toBeNull();
    // a fuel hold books for what was actually tanked
    const fuel = row('f', '2026-10-13', -15_000, 'Total Nn0001853 Den Haa');
    expect(twinScore(fuel, row('fb', '2026-10-14', -9083, 'Total Nn0001853 Den Haa'))).not.toBeNull();
  });

  it('never the other direction, a far day, or a different amount at a different merchant', () => {
    const hold = row('r', '2026-10-06', -1300, 'Albert Heijn');
    expect(twinScore(hold, row('b', '2026-10-07', 1300, 'Albert Heijn'))).toBeNull();
    expect(twinScore(hold, row('b', '2026-10-30', -1300, 'Albert Heijn'))).toBeNull();
    expect(twinScore(hold, row('b', '2026-10-01', -1300, 'Albert Heijn'))).toBeNull();
    expect(twinScore(hold, row('b', '2026-10-07', -1450, 'Jumbo'))).toBeNull();
  });

  it('pairs one booked row per hold — the older hold chooses first, so repeated payments stay in order', () => {
    const holds = [row('h1', '2026-10-06', -1300, 'TU Delft'), row('h2', '2026-10-07', -1300, 'TU Delft')];
    const booked = [row('b1', '2026-10-07', -1300, 'TU Delft'), row('b2', '2026-10-08', -1300, 'TU Delft'), row('x', '2026-10-07', -999, 'Spotify')];
    const pairs = pairReservedWithBooked(holds, booked);
    expect(pairs.get('h1')).toBe('b1');
    expect(pairs.get('h2')).toBe('b2');
    // one candidate, two holds: only one of them gets it
    const one = pairReservedWithBooked(holds, [row('b1', '2026-10-07', -1300, 'TU Delft')]);
    expect(one.size).toBe(1);
  });
});
