import { describe, expect, it } from 'vitest';
import type { ReceiptRow } from '@/db/types';
import { autoReceiptFor } from './reviewReceipt';

const receipt = (id: string, partial: Partial<ReceiptRow>): ReceiptRow =>
  ({ id, spaceId: 'feed', source: 'ah', date: '2026-11-14', totalCents: 9776, deleted: 0, ...partial }) as ReceiptRow;

const payment = (partial: { amountCents?: number; merchant?: string; date?: string; description?: string } = {}) => ({
  date: '2026-11-15',
  amountCents: -9776,
  merchant: 'Albert Heijn 1842',
  ...partial,
});

describe('the receipt a review card picks by itself (#650)', () => {
  it('user 2026-11-18: a supermarket receipt is not picked for an Amazon payment that cost nearly the same', () => {
    const amazon = payment({ amountCents: -9724, merchant: 'WWW.AMAZON.* H40FC73G5', description: 'WWW.AMAZON.* H40FC73G5 LUXEMBOURG LUX' });
    expect(autoReceiptFor(amazon, [receipt('ah', { merchant: 'Albert Heijn' })])).toBeNull();
    // not even to the cent: the payment names another shop
    expect(autoReceiptFor({ ...amazon, amountCents: -9776 }, [receipt('ah', {})])).toBeNull();
  });

  it('the amount to the cent at the shop the payment names is picked — an order charged days later too', () => {
    expect(autoReceiptFor(payment(), [receipt('ah', {})])?.id).toBe('ah');
    expect(autoReceiptFor(payment({ date: '2026-11-27' }), [receipt('ah', {})])?.id).toBe('ah');
    expect(autoReceiptFor(payment({ date: '2026-11-30' }), [receipt('ah', {})])).toBeNull();
    // the shop is read from the bank's description too
    expect(autoReceiptFor(payment({ merchant: 'CCV*5812', description: 'Albert Heijn 1842 Den Haag' }), [receipt('ah', {})])?.id).toBe('ah');
  });

  it('a cent off is the person’s to pick, whatever the shop', () => {
    expect(autoReceiptFor(payment({ amountCents: -9777 }), [receipt('ah', {})])).toBeNull();
  });

  it('a photo nobody named goes by the amount and the day alone; a named one by its shop', () => {
    const photo = receipt('p', { source: 'photo' });
    expect(autoReceiptFor(payment({ merchant: 'Snackbar' }), [photo])?.id).toBe('p');
    expect(autoReceiptFor(payment({ merchant: 'Snackbar', date: '2026-11-19' }), [photo])).toBeNull();
    const named = receipt('p', { source: 'photo', merchant: 'Bakkerij van Dam' });
    expect(autoReceiptFor(payment({ merchant: 'BAKKERIJ VAN DAM UTRECHT' }), [named])?.id).toBe('p');
    // one shared word names nobody
    expect(autoReceiptFor(payment({ merchant: 'Slagerij van Leeuwen' }), [named])).toBeNull();
    // a photo of a known shop is told by that shop's fingerprint: the bank writes "AH", the receipt "Albert Heijn"
    expect(autoReceiptFor(payment({ merchant: 'AH to go 5812' }), [receipt('p', { source: 'photo', merchant: 'Albert Heijn' })])?.id).toBe('p');
  });

  it('two receipts that fit alike are the person’s to tell apart; the nearer day decides between unequal ones', () => {
    expect(autoReceiptFor(payment(), [receipt('a', {}), receipt('b', {})])).toBeNull();
    expect(autoReceiptFor(payment(), [receipt('far', { date: '2026-11-08' }), receipt('near', {})])?.id).toBe('near');
  });

  it('money that came in gets no receipt by itself', () => {
    expect(autoReceiptFor(payment({ amountCents: 9776 }), [receipt('ah', {})])).toBeNull();
  });
});
