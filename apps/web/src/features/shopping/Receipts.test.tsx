// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';

// happy-dom has no canvas — the downscaler is covered by lib/image.test.ts
const FAKE_PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';
vi.mock('@/lib/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image')>()),
  downscaleImage: vi.fn(async () => FAKE_PHOTO),
}));

async function openFirstTx() {
  renderApp('/transactions');
  const row = await waitFor(() => {
    const el = document.querySelector('[data-testid^="tx-row-"]');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(row);
  await screen.findByTestId('receipt-empty');
}

describe('Receipts S1 (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('a photo attaches to the transaction and the delete two-tap removes it', async () => {
    await openFirstTx();

    const file = new File(['x'], 'bon.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('receipt-file'), { target: { files: [file] } });
    const card = await screen.findByTestId('receipt-card', {}, { timeout: 5000 });
    expect(card.querySelector('img')?.getAttribute('src')).toBe(FAKE_PHOTO);
    expect(card.textContent).toMatch(/€[0-9]/);

    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('receipt-delete'));
    fireEvent.click(screen.getByTestId('receipt-delete'));
    await screen.findByTestId('receipt-empty');
  }, 15_000);

  it('the connections door lists the six stores with their coming-soon status', async () => {
    await openFirstTx();
    fireEvent.click(screen.getByTestId('receipt-connections'));
    await screen.findByTestId('screen-shopping');
    expect(screen.getByTestId('shopping-privacy')).toBeTruthy();
    for (const store of ['ah', 'jumbo', 'bol', 'coolblue', 'mediamarkt', 'amazon']) {
      expect(screen.getByTestId(`shopping-store-${store}`)).toBeTruthy();
    }
    expect(screen.getByTestId('shopping-photo-note')).toBeTruthy();
  }, 15_000);

  it('settings reaches shopping connections', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-shopping-row'));
    await screen.findByTestId('screen-shopping');
  }, 15_000);
});
