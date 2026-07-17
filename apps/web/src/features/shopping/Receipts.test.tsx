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
      spaces: [
        { id: 's-user', name: 'Personal' },
        { id: 's-two', name: 'Second', kind: 'shared' },
      ],
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

    // sharing (user ruling): the connection starts private to exactly the
    // space that was active at connect time; ticking the other space opts
    // its members in
    const rows = [await screen.findByTestId('shop-ah-share-s-user'), await screen.findByTestId('shop-ah-share-s-two')];
    const checked = rows.filter((row) => row.querySelector('.mdi-checkbox-marked'));
    expect(checked).toHaveLength(1);
    const unchecked = rows.find((row) => !row.querySelector('.mdi-checkbox-marked'))!;
    fireEvent.click(unchecked);
    await waitFor(() => expect(unchecked.querySelector('.mdi-checkbox-marked')).toBeTruthy());
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    await waitFor(async () => {
      const shared = (await db.storeConnections.get('ah'))?.sharedSpaceIds ?? [];
      expect([...shared].sort((a, b) => a.localeCompare(b))).toEqual(['s-two', 's-user']);
    });
    db.close();
  }, 15_000);

  it('opened from its own transaction, the sheet hides the linked-tx block', async () => {
    await openFirstTx();
    const file = new File(['x'], 'bon.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('receipt-file'), { target: { files: [file] } });
    const card = await screen.findByTestId('receipt-card', {}, { timeout: 5000 });

    // the sheet must not point back at the transaction it sits on (user bug)
    fireEvent.click(card);
    await screen.findByTestId('receipt-view-total');
    // once transactions resolve the sheet knows the receipt IS linked:
    // no link button — and no block pointing back at this very tx
    await waitFor(() => expect(screen.queryByTestId('receipt-link-tx')).toBeNull());
    expect(screen.queryByTestId('receipt-linked-tx')).toBeNull();
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

  it('a signed-in user connects Jumbo with username/password (never stored)', async () => {
    renderAppAsUser('/shopping', {
      api: {
        'POST /shop/proxy/jumbo': (body) => {
          const request = body as { path: string };
          if (request.path === '/v17/users/login') {
            return new Response(JSON.stringify({}), { status: 200, headers: { 'x-jumbo-token': 'jt-1' } });
          }
          if (request.path === '/v17/users/me/receipts') return { receipts: [] };
          return {};
        },
      },
    });
    await screen.findByTestId('screen-shopping');

    fireEvent.click(await screen.findByTestId('shop-jumbo-connect'));
    fireEvent.change(await screen.findByTestId('shop-jumbo-user'), { target: { value: 'okkes@example.com' } });
    fireEvent.change(screen.getByTestId('shop-jumbo-pass'), { target: { value: 'geheim' } });
    fireEvent.click(screen.getByTestId('shop-jumbo-submit'));

    await waitFor(() => expect(screen.getByTestId('shop-jumbo-status').textContent).toContain('Connected'), { timeout: 5000 });
    expect(screen.getByTestId('shop-jumbo-disconnect')).toBeTruthy();
    // per-connection sharing renders for jumbo too
    expect(await screen.findByTestId('shop-jumbo-share-s-user')).toBeTruthy();
    // only the session token is kept — never the credentials
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    const connection = await db.storeConnections.get('jumbo');
    expect(connection?.tokens).toEqual({ token: 'jt-1' });
    expect(JSON.stringify(connection)).not.toContain('geheim');
    db.close();
  }, 15_000);

  it('a tarpitted Jumbo login explains the bot-protection block honestly', async () => {
    renderAppAsUser('/shopping', {
      api: {
        // the api surfaces Akamai hangs as 504 (never a raw 500)
        'POST /shop/proxy/jumbo': () => new Response('', { status: 504 }),
      },
    });
    await screen.findByTestId('screen-shopping');

    fireEvent.click(await screen.findByTestId('shop-jumbo-connect'));
    fireEvent.change(await screen.findByTestId('shop-jumbo-user'), { target: { value: 'okkes@example.com' } });
    fireEvent.change(screen.getByTestId('shop-jumbo-pass'), { target: { value: 'geheim' } });
    fireEvent.click(screen.getByTestId('shop-jumbo-submit'));

    const failed = await screen.findByTestId('shop-jumbo-failed');
    expect(failed.textContent).toContain('block connections');
    // nothing was stored
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB(USER_TEST_DB);
    expect(await db.storeConnections.get('jumbo')).toBeUndefined();
    db.close();
  }, 15_000);

  it('settings reaches receipts; the stores door reaches connections', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    // receipts are the feature's home (receipts v2); stores live inside it
    fireEvent.click(screen.getByTestId('settings-global-row'));
    fireEvent.click(await screen.findByTestId('settings-receipts-row'));
    await screen.findByTestId('screen-receipts');
    fireEvent.click(screen.getByTestId('receipts-stores'));
    expect(await screen.findByTestId('screen-shopping')).toBeTruthy();
  }, 15_000);

  it('the receipts browser groups by store and searches names and amounts', async () => {
    await openFirstTx();
    const file = new File(['x'], 'bon.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('receipt-file'), { target: { files: [file] } });
    await screen.findByTestId('receipt-card', {}, { timeout: 5000 });

    // seed a store receipt beside the photo one
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('receipt', 'demo_space', 'rcpt:ah:x1@demo_space', {
      source: 'ah',
      date: '2026-07-01',
      totalCents: 2199,
      merchant: 'Albert Heijn',
      items: [{ name: 'HALFVOLLE MELK', totalCents: 258 }],
      storeRef: 'ah:x1',
    });
    db.close();
    cleanup();

    renderApp('/receipts');
    await screen.findByTestId('screen-receipts');
    // grouped by source: the AH section and the photo section
    await screen.findByTestId('receipts-group-ah');
    await screen.findByTestId('receipts-group-photo');

    // item-name search narrows to the store receipt…
    fireEvent.change(screen.getByTestId('receipts-search'), { target: { value: 'melk' } });
    await waitFor(() => expect(screen.queryByTestId('receipts-group-photo')).toBeNull());
    expect(screen.getByTestId('receipts-group-ah')).toBeTruthy();
    // …and so does an amount query
    fireEvent.change(screen.getByTestId('receipts-search'), { target: { value: '21,99' } });
    await waitFor(() => expect(screen.getByTestId('receipts-group-ah')).toBeTruthy());
    expect(screen.queryByTestId('receipts-group-photo')).toBeNull();

    // the unlinked filter keeps only the store receipt (the photo is linked)
    fireEvent.change(screen.getByTestId('receipts-search'), { target: { value: '' } });
    fireEvent.click(await screen.findByTestId('receipts-filter-unlinked'));
    await waitFor(() => expect(screen.queryByTestId('receipts-group-photo')).toBeNull());
    expect(screen.getByTestId('receipts-group-ah')).toBeTruthy();
  }, 20_000);
});
