// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import type { ReceiptRow } from '@/db/types';
import { renderWithData } from '@/test/harness';
import { ReceiptAiRead } from './ReceiptAiRead';
import { ReceiptBody } from './ReceiptBody';
import * as receiptAi from './receiptAi';
import type { ReadReceipt, ReceiptReadReply } from './receiptAi';

const PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';
const receipt = (over: Partial<ReadReceipt> = {}): ReadReceipt => ({
  merchant: 'Albert Heijn',
  date: '2026-11-12',
  currency: 'EUR',
  totalCents: 879,
  reconciled: true,
  lines: [
    { name: 'Melk', quantity: 1, unitCents: 129, totalCents: 129, kind: 'item', categoryId: 'groceries' },
    { name: 'Appels', quantity: 0.75, unitCents: 1200, totalCents: 900, kind: 'item', categoryId: null },
    { name: 'Bonus', quantity: 1, unitCents: 150, totalCents: -150, kind: 'discount', categoryId: null },
  ],
  ...over,
});
const reply = (over: Partial<ReceiptReadReply>): ReceiptReadReply => ({ state: 'ok', receipt: receipt(), until: null, ...over });

/** #567: a receipt photo read by a vision model through munni's API */
describe('reading a receipt photo', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('asks once where the photo may go; no is remembered and nothing is sent; yes reads with the person’s categories', async () => {
    const read = vi.spyOn(receiptAi, 'readReceiptPhotos').mockResolvedValue(reply({}));
    const onRead = vi.fn(async () => undefined);
    renderWithData(<ReceiptAiRead images={[PHOTO]} hasItems={false} onRead={onRead} />);

    fireEvent.click(await screen.findByTestId('receipt-ai-read'));
    expect((await screen.findByTestId('receipt-ai-ask')).textContent).toContain('Claude, by Anthropic');
    fireEvent.click(screen.getByTestId('receipt-ai-no'));
    expect(receiptAi.receiptAiChoice()).toBe('no');
    expect(read).not.toHaveBeenCalled();

    // the door is not gone: the next tap asks again
    fireEvent.click(screen.getByTestId('receipt-ai-read'));
    fireEvent.click(screen.getByTestId('receipt-ai-yes'));
    await waitFor(() => expect(onRead).toHaveBeenCalledTimes(1));
    expect(receiptAi.receiptAiChoice()).toBe('yes');
    const [images, categories] = read.mock.calls[0];
    expect(images).toEqual([PHOTO]);
    // every sub under its main, so the reader can tell a grocery from a restaurant
    expect(categories.find((c) => c.id === 'groceries')?.name).toBe('Consumption › Grocery');
    expect(onRead).toHaveBeenCalledWith({
      reconciled: true,
      currency: 'EUR',
      items: [
        { name: 'Melk', totalCents: 129, catId: 'groceries' },
        { name: 'Appels', qty: 0.75, unitCents: 1200, totalCents: 900 },
        { name: 'Bonus', totalCents: -150, kind: 'discount' },
      ],
    });
  });

  it('once agreed, a tap reads straight away — and every way it can come to nothing says what happened', async () => {
    receiptAi.setReceiptAiChoice('yes');
    const read = vi.spyOn(receiptAi, 'readReceiptPhotos');
    const onRead = vi.fn(async () => undefined);
    renderWithData(<ReceiptAiRead images={[PHOTO]} hasItems onRead={onRead} />);
    const button = await screen.findByTestId('receipt-ai-read');
    expect(button.textContent).toBe('Read again');

    const outcomes: [Partial<ReceiptReadReply>, RegExp][] = [
      [{ state: 'limited', receipt: null, until: '2026-11-13T00:00:00Z' }, /today’s receipts.*back on .*November/],
      [{ state: 'capped', receipt: null, until: '2026-12-01T00:00:00Z' }, /This month’s receipts.*December/],
      [{ state: 'unreadable', receipt: null }, /No receipt could be read/],
      [{ state: 'unavailable', receipt: null }, /not available right now/],
    ];
    for (const [answer, text] of outcomes) {
      read.mockResolvedValueOnce(reply(answer));
      fireEvent.click(button);
      await waitFor(() => expect(screen.getByTestId('receipt-ai-note').getAttribute('data-state')).toBe(answer.state));
      expect(screen.getByTestId('receipt-ai-note').textContent).toMatch(text);
    }
    expect(screen.queryByTestId('receipt-ai-ask')).toBeNull();
    expect(onRead).not.toHaveBeenCalled();
  });

  it('the API is asked with the photos and the categories; no answer is "not available", never an error', async () => {
    const apiFetch = vi.spyOn(api, 'apiFetch').mockResolvedValue(new Response(JSON.stringify(reply({})), { status: 200 }));
    const answer = await receiptAi.readReceiptPhotos([PHOTO], [{ id: 'groceries', name: 'Groceries' }]);
    expect(answer.state).toBe('ok');
    const [path, init] = apiFetch.mock.calls[0];
    expect(path).toBe('/receipts/read');
    expect(JSON.parse(String(init?.body))).toEqual({ images: [PHOTO], categories: [{ id: 'groceries', name: 'Groceries' }] });

    apiFetch.mockResolvedValue(new Response(null, { status: 502 }));
    expect((await receiptAi.readReceiptPhotos([PHOTO], [])).state).toBe('unavailable');
    apiFetch.mockRejectedValue(new Error('offline'));
    expect(await receiptAi.readReceiptPhotos([PHOTO], [])).toEqual({ state: 'unavailable', receipt: null, until: null });
  });

  it('the receipt shows the reader’s suggestion under a line, two identical lines as two, and says when the lines do not add up', async () => {
    const row = {
      id: 'r1',
      spaceId: 'demo_space',
      source: 'photo',
      date: '2026-11-12',
      totalCents: 500,
      merchant: 'Shop',
      reconciled: false,
      items: [
        { name: 'Lavazza', totalCents: 199, catId: 'coffee' },
        { name: 'Lavazza', totalCents: 199 },
      ],
      hlc: '',
      deleted: 0,
      fieldVersions: {},
    } as unknown as ReceiptRow;
    renderWithData(<ReceiptBody receipt={row} currency="EUR" />);
    const first = await screen.findByTestId(/item-cat-0$/);
    expect(first.textContent).toMatch(/^Suggested: .*Coffee/);
    expect(screen.queryByTestId(/item-cat-1$/)).toBeNull();
    expect(screen.getAllByText('Lavazza')).toHaveLength(2);
    expect(screen.getByTestId(/unreconciled$/)).toBeTruthy();
  });
});
