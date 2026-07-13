// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

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
    indexedDB.deleteDatabase(USER_TEST_DB);
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

  it('the connections door lists the six stores; demo cannot connect', async () => {
    await openFirstTx();
    fireEvent.click(screen.getByTestId('receipt-connections'));
    await screen.findByTestId('screen-shopping');
    expect(screen.getByTestId('shopping-privacy')).toBeTruthy();
    for (const store of ['ah', 'jumbo', 'bol', 'coolblue', 'mediamarkt', 'amazon']) {
      expect(screen.getByTestId(`shopping-store-${store}`)).toBeTruthy();
    }
    expect(screen.getByTestId('shopping-photo-note')).toBeTruthy();
    // demo identity: zero network — no connect affordance, just the note
    expect(screen.getByTestId('shopping-signin-note')).toBeTruthy();
    expect(screen.queryByTestId('shop-ah-connect')).toBeNull();
  }, 15_000);

  it('a signed-in user connects AH by pasting the redirect address', async () => {
    renderAppAsUser('/shopping', {
      api: {
        'POST /shop/proxy/ah-api': (body) => {
          const request = body as { path: string };
          if (request.path === '/mobile-auth/v1/auth/token') return { access_token: 'acc-1', refresh_token: 'ref-1' };
          if (request.path === '/mobile-services/v2/receipts') return [];
          return {};
        },
      },
    });
    await screen.findByTestId('screen-shopping');
    expect(screen.queryByTestId('shopping-signin-note')).toBeNull();

    fireEvent.click(await screen.findByTestId('shop-ah-connect'));
    fireEvent.change(await screen.findByTestId('shop-ah-paste'), {
      target: { value: 'appie://login-exit?code=abc-12345' },
    });
    fireEvent.click(screen.getByTestId('shop-ah-submit'));
    // connected state answers out loud: status line, verified sync result
    await screen.findByTestId('shop-ah-sync', {}, { timeout: 5000 });
    expect(screen.getByTestId('shop-ah-disconnect')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('shop-ah-status').textContent).toContain('Connected'));
    await screen.findByTestId('shop-ah-sync-result');
  }, 15_000);

  it('the receipts browser lists receipts and opens the full view', async () => {
    await openFirstTx();
    const file = new File(['x'], 'bon.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('receipt-file'), { target: { files: [file] } });
    await screen.findByTestId('receipt-card', {}, { timeout: 5000 });

    cleanup();
    renderApp('/receipts');
    await screen.findByTestId('screen-receipts');
    const row = await waitFor(
      () => {
        const el = document.querySelector('[data-testid^="receipt-row-"]');
        expect(el).toBeTruthy();
        return el!;
      },
      { timeout: 5000 },
    );
    expect(row.textContent).toMatch(/€[0-9]/);

    fireEvent.click(row);
    // photo receipts attach on capture → the linked transaction shows
    await screen.findByTestId('receipt-view-total');
    await screen.findByTestId('receipt-linked-tx');
  }, 15_000);

  it('settings reaches shopping connections', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    // shopping moved behind the Global settings door
    fireEvent.click(screen.getByTestId('settings-global-row'));
    fireEvent.click(await screen.findByTestId('settings-shopping-row'));
    expect(await screen.findByTestId('screen-shopping')).toBeTruthy();
  }, 15_000);
});
