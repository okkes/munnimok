// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp } from '@/test/harness';
import { clampZoom, dataUrlBytes } from './PdfView';

// pdf.js is mocked: happy-dom has no canvas, and the viewer's shape is what is under test
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 2,
      getPage: () =>
        Promise.resolve({
          getViewport: ({ scale }: { scale: number }) => ({ width: 595 * scale, height: 842 * scale }),
          render: () => ({ promise: Promise.resolve() }),
        }),
    }),
  }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }));

// happy-dom has no canvas — the downscaler is covered by lib/image.test.ts
const FAKE_PHOTO = 'data:image/jpeg;base64,ZmFrZQ==';
vi.mock('@/lib/image', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/image')>()),
  downscaleImage: vi.fn(async () => FAKE_PHOTO),
}));

async function openFirstTx(): Promise<string> {
  renderApp('/transactions');
  const row = await waitFor(() => {
    const el = document.querySelector('[data-testid^="tx-row-"]');
    expect(el).toBeTruthy();
    return el!;
  });
  fireEvent.click(row);
  await screen.findByTestId('receipt-empty');
  return row.getAttribute('data-testid')!.slice('tx-row-'.length);
}

/** a second handle on the demo database, the way the app's own writes look to a screen */
async function demoRepo() {
  const { MunniDB } = await import('@/db/schema');
  const { Repo } = await import('@/db/repo');
  const { DexieBackend } = await import('@/db/backend');
  const { HlcClock } = await import('@/sync/hlc');
  const db = new MunniDB('munni_demo');
  return { db, repo: new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false }) };
}

describe('Receipts (demo identity)', () => {
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

  it('the connections door reaches the hub; the demo shows its connections and cannot connect', async () => {
    await openFirstTx();
    // the rich demo seed stays off under vitest (demo-rich.test.ts covers
    // it): the two connections it would write are written here
    const { db, repo } = await demoRepo();
    const { storeConnLinkId } = await import('@/domain/feedIds');
    await repo.upsert('storeConn', 'demo_store_feed', 'demo_conn_ah', { store: 'ah', displayName: 'Albert Heijn', connectedAt: '2026-08-01', status: 'ok' });
    await repo.upsert('storeConn', 'demo_store_feed', 'demo_conn_jumbo', { store: 'jumbo', displayName: 'Jumbo', connectedAt: '2026-09-01', status: 'expired' });
    await repo.upsert('storeConnLink', 'demo_space', storeConnLinkId('demo_space', 'demo_conn_ah'), { instanceId: 'demo_conn_ah', store: 'ah', displayName: 'Albert Heijn' });
    await repo.store.connectorConnPut({ id: 'demo_conn_ah', provider: 'ah', bundle: 'sb_v1.demo', state: 'active', refreshedAt: '2026-09-29T08:00:00Z', lastSyncAt: '2026-09-29T08:00:00Z' });
    await repo.store.connectorConnPut({ id: 'demo_conn_jumbo', provider: 'jumbo', state: 'needs_reauth', refreshedAt: '2026-09-27T08:00:00Z' });
    db.close();
    // R8: the attach sheet is the one door — the hub links at its bottom
    fireEvent.click(screen.getByTestId('receipt-empty'));
    fireEvent.click(await screen.findByTestId('receipt-connections'));
    await screen.findByTestId('screen-connections');
    expect(screen.getByTestId('conn-privacy')).toBeTruthy();
    // the seed: Albert Heijn synced on this device, Jumbo asking for a sign-in
    const ah = await screen.findByTestId('conn-card-demo_conn_ah');
    expect(ah.textContent).toContain('Albert Heijn');
    expect((await screen.findByTestId('conn-state-demo_conn_ah')).textContent).toMatch(/Synced/);
    expect((await screen.findByTestId('conn-state-demo_conn_jumbo')).textContent).toMatch(/Reconnect needed/);
    expect(screen.getByTestId('conn-usedin-demo_conn_ah').textContent).toContain('Demo');
    // demo identity: zero network — no catalogue door, no sync, just the note
    expect(screen.getByTestId('conn-signin-note')).toBeTruthy();
    expect(screen.queryByTestId('conn-add-open')).toBeNull();
    expect(screen.queryByTestId('conn-sync-demo_conn_ah')).toBeNull();
    expect(screen.getByTestId('conn-photo-note')).toBeTruthy();
  }, 15_000);

  it('opened from its own transaction, the receipt screen hides the linked-tx block', async () => {
    await openFirstTx();
    const file = new File(['x'], 'bon.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('receipt-file'), { target: { files: [file] } });
    const card = await screen.findByTestId('receipt-card', {}, { timeout: 5000 });

    // the screen must not point back at the transaction it was opened from (user bug)
    fireEvent.click(card);
    await screen.findByTestId('screen-receipt');
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
        const el = document.querySelector('[data-testid^="receipt-row-"][data-testid*="-"]');
        expect(el).toBeTruthy();
        return el!;
      },
      { timeout: 5000 },
    );
    expect(row.textContent).toMatch(/€[0-9]/);
    // a tap opens the receipt full screen (user request 2026-10-02: the sheet was cramped)
    fireEvent.click(row);
    await screen.findByTestId('screen-receipt');
    expect((await screen.findByTestId('receipt-view-total')).textContent).toMatch(/€[0-9]/);
    expect(screen.getByTestId('receipt-head')).toBeTruthy();
    fireEvent.click(screen.getByTestId('receipt-back'));
  }, 15_000);

  it('settings reaches receipts; the connections door reaches the hub', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    // v3: receipts live in the SPACE section; connections stay a global door
    fireEvent.click(await screen.findByTestId('settings-receipts-row'));
    await screen.findByTestId('screen-receipts');
    fireEvent.click(screen.getByTestId('receipts-connections'));
    expect(await screen.findByTestId('screen-connections')).toBeTruthy();
  }, 15_000);

  it('the receipts browser groups by party and searches names and amounts', async () => {
    await openFirstTx();
    const file = new File(['x'], 'bon.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('receipt-file'), { target: { files: [file] } });
    await screen.findByTestId('receipt-card', {}, { timeout: 5000 });

    // seed a Jumbo receipt's snapshot (present, not attached) beside the photo one
    const { db, repo } = await demoRepo();
    await repo.upsert('receiptLink', 'demo_space', 'rlink-jumbo-x1', {
      receiptId: 'rcpt:jumbo:demo_conn_jumbo:x1',
      source: 'jumbo',
      date: '2026-07-01',
      totalCents: 2199,
      merchant: 'Jumbo',
      items: [{ name: 'HALFVOLLE MELK', totalCents: 258 }],
    });
    db.close();
    cleanup();

    renderApp('/receipts');
    await screen.findByTestId('screen-receipts');
    // grouped by source: the Jumbo section and the photo section
    await screen.findByTestId('receipts-group-jumbo');
    await screen.findByTestId('receipts-group-photo');

    // item-name search narrows to the store receipt…
    fireEvent.change(screen.getByTestId('receipts-search'), { target: { value: 'melk' } });
    await waitFor(() => expect(screen.queryByTestId('receipts-group-photo')).toBeNull());
    expect(screen.getByTestId('receipts-group-jumbo')).toBeTruthy();
    // …and so does an amount query
    fireEvent.change(screen.getByTestId('receipts-search'), { target: { value: '21,99' } });
    await waitFor(() => expect(screen.getByTestId('receipts-group-jumbo')).toBeTruthy());
    expect(screen.queryByTestId('receipts-group-photo')).toBeNull();

    // the unlinked filter keeps only the store receipt (the photo is linked)
    fireEvent.change(screen.getByTestId('receipts-search'), { target: { value: '' } });
    fireEvent.click(await screen.findByTestId('receipts-filter-unlinked'));
    await waitFor(() => expect(screen.queryByTestId('receipts-group-photo')).toBeNull());
    expect(screen.getByTestId('receipts-group-jumbo')).toBeTruthy();
  }, 20_000);

  it('a fetched receipt carries its invoice, opened in place (#367)', async () => {
    renderApp('/receipts');
    await screen.findByTestId('screen-receipts');
    const { db, repo } = await demoRepo();
    await repo.upsert('receiptLink', 'demo_space', 'rlink-bol-inv', {
      receiptId: 'rcpt:bol:c1:o-1',
      source: 'bol',
      date: '2026-07-02',
      totalCents: 4999,
      merchant: 'bol',
      documents: [{ kind: 'invoice', mime: 'application/pdf', filename: 'factuur-1.pdf', dataUrl: 'data:application/pdf;base64,JVBERi0=' }],
    });
    db.close();
    const row = await screen.findByTestId('receipt-row-rcpt:bol:c1:o-1', {}, { timeout: 5000 });
    expect(row.textContent).toContain('Invoice');
    fireEvent.click(row);
    await screen.findByTestId('receipt-documents');
    fireEvent.click(screen.getByTestId('receipt-document-0'));
    await screen.findByTestId('receipt-invoice-view');
    expect((screen.getByTestId('receipt-invoice-download') as HTMLAnchorElement).getAttribute('download')).toBe('factuur-1.pdf');
    // user 2026-10-06: drawn page by page at the frame's width, the sheet at full height; the toolbar zooms
    await screen.findByTestId('receipt-pdf-page-2');
    expect(screen.getByTestId('receipt-invoice-view').closest('[data-full]')).toBeTruthy();
    expect(screen.getByTestId('receipt-pdf-zoom').textContent).toBe('100%');
    expect((screen.getByTestId('receipt-pdf-zoom-out') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('receipt-pdf-zoom-in'));
    expect(screen.getByTestId('receipt-pdf-zoom').textContent).toBe('125%');
    expect((screen.getByTestId('receipt-pdf-zoom-out') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('receipt-pdf-zoom-fit'));
    expect(screen.getByTestId('receipt-pdf-zoom').textContent).toBe('100%');
  }, 15_000);

  it('the viewer\'s helpers: zoom never goes under the width nor past 4×; a data URL yields its bytes', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(1.2345)).toBe(1.23);
    expect([...dataUrlBytes('data:application/pdf;base64,JVBERi0=')]).toEqual([37, 80, 68, 70, 45]);
    expect(dataUrlBytes('nonsense')).toHaveLength(0);
  });

  it('a proposed match asks on the transaction; yes attaches it (§5.7)', async () => {
    const txId = await openFirstTx();
    const { db, repo } = await demoRepo();
    await repo.upsert('receiptLink', 'demo_space', 'rlink-proposed', {
      receiptId: 'rcpt:ah:demo_conn_ah:p1',
      source: 'ah',
      instanceId: 'demo_conn_ah',
      date: '2026-07-03',
      totalCents: 1250,
      merchant: 'Albert Heijn',
      auto: 0,
      proposedTxId: txId,
    });
    db.close();
    const proposal = await screen.findByTestId('receipt-proposal', {}, { timeout: 5000 });
    expect(proposal.textContent).toContain('Receipt to check');
    fireEvent.click(screen.getByTestId('receipt-proposal-accept'));
    await screen.findByTestId('receipt-card', {}, { timeout: 5000 });
    expect(screen.queryByTestId('receipt-proposal')).toBeNull();

    // the receipts screen lists what is left to check — nothing now
    cleanup();
    renderApp('/receipts');
    await screen.findByTestId('screen-receipts');
    await waitFor(() => expect(document.querySelector('[data-testid^="receipt-row-"]')).toBeTruthy());
    expect(screen.queryByTestId('receipts-to-check')).toBeNull();
  }, 20_000);

  it('a match to check opens the receipt and the transaction it fits, so the answer is not a guess (user ss 2026-10-05)', async () => {
    const txId = await openFirstTx();
    const { db, repo } = await demoRepo();
    await repo.upsert('receiptLink', 'demo_space', 'rlink-compare', {
      receiptId: 'rcpt:ah:demo_conn_ah:p2',
      source: 'ah',
      instanceId: 'demo_conn_ah',
      date: '2026-07-03',
      totalCents: 1250,
      merchant: 'Albert Heijn',
      auto: 0,
      proposedTxId: txId,
    });
    db.close();
    cleanup();
    renderApp('/receipts');
    await screen.findByTestId('receipts-to-check', {}, { timeout: 5000 });
    const txDoor = await screen.findByTestId('receipt-proposal-tx-rlink-compare', {}, { timeout: 5000 });
    expect(txDoor.textContent).toContain('Looks like it belongs to');
    expect(txDoor.textContent).toMatch(/€/);
    fireEvent.click(txDoor);
    await screen.findByTestId('tx-detail-amount', {}, { timeout: 5000 });
    cleanup();
    renderApp('/receipts');
    fireEvent.click(await screen.findByTestId('receipt-proposal-open-rlink-compare', {}, { timeout: 5000 }));
    await screen.findByTestId('screen-receipt', {}, { timeout: 5000 });
  }, 20_000);

  const AMAZON = 'rcpt:amazon-nl:demo_conn_amz:a1';
  const COOLBLUE = 'rcpt:coolblue:demo_conn_cb:c1';

  /** two shops in the space with an unlinked receipt each (the review's seeding, on the detail's demo handle) */
  async function seedTwoShopReceipts() {
    const { db, repo } = await demoRepo();
    const { DEMO_STORE_FEED_ID } = await import('@/application/storeFeed');
    const { storeConnLinkId } = await import('@/domain/feedIds');
    await repo.upsert('storeConnLink', 'demo_space', storeConnLinkId('demo_space', 'demo_conn_amz'), { instanceId: 'demo_conn_amz', store: 'amazon-nl', displayName: 'Amazon' });
    await repo.upsert('storeConnLink', 'demo_space', storeConnLinkId('demo_space', 'demo_conn_cb'), { instanceId: 'demo_conn_cb', store: 'coolblue', displayName: 'Coolblue' });
    await repo.upsert('receipt', DEMO_STORE_FEED_ID, AMAZON, { source: 'amazon-nl', instanceId: 'demo_conn_amz', date: '2026-01-09', totalCents: 5956, merchant: 'Amazon.nl' });
    await repo.upsert('receipt', DEMO_STORE_FEED_ID, COOLBLUE, { source: 'coolblue', instanceId: 'demo_conn_cb', date: '2026-01-06', totalCents: 5798, merchant: 'Coolblue' });
    db.close();
    // the shops' receipts reach the empty state's badge
    await waitFor(() => expect(screen.getByTestId('receipt-candidate-count').textContent).toBe('2'), { timeout: 5000 });
  }

  it('the attach sheet searches every receipt behind the parties’ chips; a pick from the whole list attaches it (user 2026-10-07)', async () => {
    await openFirstTx();
    await seedTwoShopReceipts();
    fireEvent.click(screen.getByTestId('receipt-empty'));
    await screen.findByTestId('receipt-pick-sheet');
    // nothing attached: no None option; the suggestions and the whole list are both there
    expect(screen.queryByTestId('receipt-pick-none')).toBeNull();
    expect(screen.getByTestId('receipt-pick-list').textContent).toContain('Amazon.nl');
    expect(screen.getByTestId('receipt-pick-all-list').textContent).toContain('Coolblue');
    fireEvent.click(screen.getByTestId('receipt-pick-party-coolblue'));
    expect(screen.queryByTestId(`receipt-pick-all-${AMAZON}`)).toBeNull();
    fireEvent.change(screen.getByTestId('receipt-pick-search'), { target: { value: '57,98' } });
    fireEvent.click(screen.getByTestId(`receipt-pick-all-${COOLBLUE}`));
    const card = await screen.findByTestId('receipt-card', {}, { timeout: 5000 });
    expect(card.textContent).toContain('Coolblue');
    expect(card.textContent).toMatch(/€[1-9]/);
  }, 20_000);

  it('Change on the attached receipt opens the sheet with it marked; another pick swaps the link, No receipt lets it go', async () => {
    const txId = await openFirstTx();
    await seedTwoShopReceipts();
    fireEvent.click(screen.getByTestId('receipt-empty'));
    fireEvent.click(await screen.findByTestId(`receipt-pick-${AMAZON}`));
    await waitFor(() => expect(screen.getByTestId('receipt-card').textContent).toContain('Amazon.nl'), { timeout: 5000 });

    // Change: the attached receipt leads the suggestions, marked, and None is on offer now
    fireEvent.click(screen.getByTestId('receipt-change'));
    await waitFor(() => expect(screen.getByTestId(`receipt-pick-${AMAZON}`).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId('receipt-pick-none')).toBeTruthy();
    fireEvent.click(screen.getByTestId(`receipt-pick-${COOLBLUE}`));
    await waitFor(() => expect(screen.getByTestId('receipt-card').textContent).toContain('Coolblue'), { timeout: 5000 });

    // the swap: the Coolblue link holds the transaction, the Amazon link is gone (its receipt is unmatched again)
    const { db } = await demoRepo();
    await waitFor(async () => {
      const links = await db.receiptLinks.toArray();
      expect(links.find((l) => l.receiptId === COOLBLUE)?.txId).toBe(txId);
      expect(links.find((l) => l.receiptId === AMAZON)?.deleted).toBeTruthy();
    }, { timeout: 5000 });
    db.close();
    fireEvent.click(screen.getByTestId('receipt-change'));
    await waitFor(() => expect(screen.getByTestId(`receipt-pick-${COOLBLUE}`).getAttribute('aria-pressed')).toBe('true'));
    expect(screen.getByTestId(`receipt-pick-${AMAZON}`).getAttribute('aria-pressed')).toBe('false');

    // No receipt: the transaction is bare again
    fireEvent.click(screen.getByTestId('receipt-pick-none'));
    await screen.findByTestId('receipt-empty', {}, { timeout: 5000 });
  }, 25_000);

  const BOL = 'rcpt:bol:demo_conn_bol:b1';

  /** one bol.com receipt and the two demo-space payments it covers (user 2026-10-08); the link when asked for */
  async function seedOneReceiptTwoPayments(linked: boolean) {
    const { db, repo } = await demoRepo();
    const { DEMO_STORE_FEED_ID } = await import('@/application/storeFeed');
    const { receiptLinkId, storeConnLinkId } = await import('@/domain/feedIds');
    await repo.upsert('storeConnLink', 'demo_space', storeConnLinkId('demo_space', 'demo_conn_bol'), { instanceId: 'demo_conn_bol', store: 'bol', displayName: 'bol.com' });
    await repo.upsert('receipt', DEMO_STORE_FEED_ID, BOL, { source: 'bol', instanceId: 'demo_conn_bol', date: '2026-05-29', totalCents: 15733, merchant: 'bol.com' });
    await repo.upsert('transaction', 'demo_space', 'pay1', { accountId: 'demo_main', date: '2026-05-29', amountCents: -10000, currency: 'EUR', merchant: 'bol.com', catId: 'groceries', needsReview: 0 });
    await repo.upsert('transaction', 'demo_space', 'pay2', { accountId: 'demo_main', date: '2026-05-30', amountCents: -5733, currency: 'EUR', merchant: 'bol.com', catId: 'groceries', needsReview: 0 });
    if (linked) {
      await repo.upsert('receiptLink', 'demo_space', receiptLinkId('demo_space', BOL), {
        receiptId: BOL, source: 'bol', instanceId: 'demo_conn_bol', date: '2026-05-29', totalCents: 15733, merchant: 'bol.com', txId: 'pay1', alsoTxIds: ['pay2'], auto: 0,
      });
    }
    db.close();
  }

  it('one receipt, two payments (user 2026-10-08): the sheet says where a receipt already sits, picking it there too keeps it on both', async () => {
    await openFirstTx();
    await seedOneReceiptTwoPayments(false);
    cleanup();
    renderApp('/transactions/pay1');
    fireEvent.click(await screen.findByTestId('receipt-empty', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId(`receipt-pick-${BOL}`));
    await waitFor(() => expect(screen.getByTestId('receipt-card').textContent).toContain('bol.com'), { timeout: 5000 });

    // the second payment: no suggestion any more (it is attached), but in the whole list with the note — still pickable
    cleanup();
    renderApp('/transactions/pay2');
    fireEvent.click(await screen.findByTestId('receipt-empty', {}, { timeout: 5000 }));
    await screen.findByTestId('receipt-pick-sheet');
    expect(screen.queryByTestId(`receipt-pick-${BOL}`)).toBeNull();
    const note = await screen.findByTestId(`receipt-pick-all-${BOL}-attached`);
    expect(note.textContent).toContain('Attached to');
    expect(note.textContent).toContain('bol.com');
    expect(note.textContent).toMatch(/€[1-9]/);
    fireEvent.click(screen.getByTestId(`receipt-pick-all-${BOL}`));
    await waitFor(() => expect(screen.getByTestId('receipt-card').textContent).toContain('bol.com'), { timeout: 5000 });

    // ONE link, both payments on it — the first stays the first
    const { db } = await demoRepo();
    await waitFor(async () => {
      const link = (await db.receiptLinks.toArray()).find((l) => l.receiptId === BOL);
      expect(link?.txId).toBe('pay1');
      expect(link?.alsoTxIds).toEqual(['pay2']);
    }, { timeout: 5000 });
    db.close();

    // the Receipts screen counts the holders; the receipt screen lists both payments
    cleanup();
    renderApp('/receipts');
    await screen.findByTestId('screen-receipts');
    expect((await screen.findByTestId(`receipt-multi-${BOL}`, {}, { timeout: 5000 })).textContent).toContain('2');
    fireEvent.click(screen.getByTestId(`receipt-row-${BOL}`));
    await screen.findByTestId('screen-receipt');
    await screen.findByTestId('receipt-linked-pay1', {}, { timeout: 5000 });
    expect(screen.getByTestId('receipt-linked-pay2')).toBeTruthy();
    expect(screen.getByTestId('receipt-delete').textContent).toBe('Unlink receipt');
  }, 30_000);

  it('opened from one of its payments, the receipt detaches from that one only — the other keeps it', async () => {
    await openFirstTx();
    await seedOneReceiptTwoPayments(true);
    cleanup();
    renderApp('/transactions/pay2');
    fireEvent.click(await screen.findByTestId('receipt-card', {}, { timeout: 5000 }));
    await screen.findByTestId('screen-receipt');
    // the list points at the OTHER payment only; the button names the one hold it lets go of
    await screen.findByTestId('receipt-linked-pay1', {}, { timeout: 5000 });
    expect(screen.queryByTestId('receipt-linked-pay2')).toBeNull();
    expect(screen.getByTestId('receipt-delete').textContent).toBe('Detach from this transaction');
    fireEvent.click(screen.getByTestId('receipt-delete'));
    fireEvent.click(screen.getByTestId('receipt-delete'));
    await screen.findByTestId('receipt-empty', {}, { timeout: 5000 });

    const { db } = await demoRepo();
    await waitFor(async () => {
      const link = (await db.receiptLinks.toArray()).find((l) => l.receiptId === BOL);
      expect(link?.deleted).toBe(0);
      expect(link?.txId).toBe('pay1');
      expect(link?.alsoTxIds ?? null).toBeNull();
    }, { timeout: 5000 });
    db.close();
  }, 25_000);
});
