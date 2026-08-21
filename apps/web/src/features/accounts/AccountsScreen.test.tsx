// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CAMT_FIXTURE } from '@/test/camt-fixture';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

// #226 r2: a minimal real-shape PayPal activity export — columns are
// looked up by header name, so the short header parses fine
const PAYPAL_CSV = [
  '"Date","Time","TimeZone","Name","Type","Status","Currency","Gross","Fee","Net","From Email Address","To Email Address","Transaction ID","Balance","Balance Impact"',
  '"06/01/2026","12:00:00","CET","Acme Music","General Payment","Completed","EUR","-23,00","0,00","-23,00","me@example.com","billing@acme.example","TXA1","-23,00","Debit"',
].join('\n');

describe('AccountsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('lists the seeded demo accounts', async () => {
    renderApp('/accounts');
    expect(await screen.findByTestId('account-row-demo_main')).toBeTruthy();
    expect(screen.getByTestId('account-row-demo_save')).toBeTruthy();
  });

  it('feed accounts show their attachments and open the attach sheet', async () => {
    // seed a feed-shaped account (its spaceId has no space row) attached
    // to the demo space via a link mirror — the global overview echoes it
    // under the space section and tapping opens attach management, not
    // the editor
    const first = renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
      lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
      dataThroughDate: '2026-06-07',
    });
    // a RAW row in the feed space — the newest-transaction fact (#205)
    await repo.upsert('transaction', 'feed-1', 'feedtx-1', {
      accountId: 'feedacct-1',
      date: '2026-06-10',
      amountCents: -1200,
      currency: 'EUR',
      merchant: 'SHELL',
      txType: 'expense',
    });
    await repo.upsert('accountLink', 'demo_space', 'link-1', {
      feedSpaceId: 'feed-1',
      accountId: 'feedacct-1',
      attachedByName: 'Okkes',
    });
    db.close();
    first.unmount();

    renderApp('/accounts');
    const row = await screen.findByTestId('account-row-feedacct-1');
    // #227: no "via space" subtitle — the row says the IBAN instead…
    expect(screen.getByTestId('account-via-feedacct-1').textContent).toContain('NL69INGB0123456789');
    expect(screen.getByTestId('account-via-feedacct-1').textContent).not.toContain('Demo');
    // …and the attachment echoes as an inert row inside the space section
    expect(await screen.findByTestId('account-echo-demo_space-feedacct-1')).toBeTruthy();
    // when the bank last answered (user request)
    expect(screen.getByTestId('account-synced-feedacct-1').textContent).toContain('minutes ago');

    fireEvent.click(row);
    expect(await screen.findByTestId('attach-spaces')).toBeTruthy();
    // the sheet lists ONLY attached spaces now (checkboxes retired)
    expect(screen.getByTestId('attach-space-demo_space')).toBeTruthy();
    expect(screen.getByTestId('attach-detach-demo_space')).toBeTruthy();
    expect(screen.queryByTestId('acctedit-name')).toBeNull(); // not the editor
    // #205: where the data ends + the newest transaction on the account
    expect(screen.getByTestId('attach-datathrough').textContent).toContain('2026-06-07');
    await waitFor(() => expect(screen.getByTestId('attach-newest-tx').textContent).toContain('2026-06-10'));
  });

  it('an icon pick shows up while the attach sheet stays open', async () => {
    // regression: the sheet rendered the entry SNAPSHOT, so a freshly
    // picked icon looked like it did nothing until the screen was reopened
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('brands/index.json')
        ? new Response(JSON.stringify([{ slug: 'netflix', title: 'Netflix' }]), { status: 200 })
        : new Response('', { status: 404 }),
    );
    const first = renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 'demo_space', 'link-1', {
      feedSpaceId: 'feed-1',
      accountId: 'feedacct-1',
    });
    db.close();
    first.unmount();

    renderApp('/accounts');
    fireEvent.click(await screen.findByTestId('account-row-feedacct-1'));
    fireEvent.click(await screen.findByTestId('attach-change-icon'));
    fireEvent.change(await screen.findByTestId('brandpicker-search'), { target: { value: 'netflix' } });
    fireEvent.click(await screen.findByTestId('brandpicker-netflix'));
    // no close/reopen: the live account row swaps the button's icon in place
    await waitFor(() => expect(screen.getByTestId('attach-change-icon').querySelector('img')).toBeTruthy());
    fetchMock.mockRestore();
  }, 15_000);

  it('#248: no attach nag — an unattached account wears a quiet badge on its own row', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    // fresh bank connect: the account exists in its feed space, but NO
    // accountLink row anywhere — the server never attaches (#204 r2)
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    db.close();

    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
      },
    });

    // the badge says it plainly; the green offer card is gone for good
    await screen.findByTestId('account-unattached-feedacct-1', {}, { timeout: 5000 });
    expect(screen.queryByTestId('attach-offer')).toBeNull();
  }, 15_000);

  it('space accounts screen attaches one of my feed accounts — the space decides the history start (#207)', async () => {
    // redesign: attaching happens on the space's own accounts screen —
    // pick an existing account and attach; the history start is no
    // longer asked per attach (#207), the space's own default governs
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    db.close();

    let attachBody: { historyFrom?: string } | undefined;
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        // production /me/spaces includes reachable feeds — without feed-1
        // here the engine treats it as lost access and purges the account
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'POST /spaces/s-user/accounts': (body) => {
          attachBody = body as { historyFrom?: string };
          return {};
        },
      },
    });

    fireEvent.click(await screen.findByTestId('space-accounts-attach'));
    fireEvent.click(await screen.findByTestId('space-attach-pick-feedacct-1'));
    // #207: the per-attach date field is gone for good
    expect(screen.queryByTestId('space-attach-history')).toBeNull();
    fireEvent.click(screen.getByTestId('space-attach-save'));
    // the space's default history start reaches the server (no
    // historyStartDate on the space → the app default applies)
    const { DEFAULT_HISTORY_MONTHS, isoMonthsAgo } = await import('@/features/spaces/spaceDefaults');
    await waitFor(() => expect(attachBody?.historyFrom).toBe(isoMonthsAgo(DEFAULT_HISTORY_MONTHS)), { timeout: 5000 });
    // …and the synced mirror renders the attachment as a tappable row
    await waitFor(() => expect(screen.getByTestId('space-accounts-list').textContent).toContain('ING Betaal'), { timeout: 5000 });
  }, 15_000);

  it('space accounts screen detaches through the danger sheet', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 's-user', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1' });
    db.close();

    let detached = false;
    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
        'DELETE /spaces/s-user/accounts/srv-1': () => {
          detached = true;
          return {};
        },
      },
    });

    // detach moved into the row's info sheet (redesign ss13): tap the
    // row, then the sheet's Detach, then the shared danger confirm
    fireEvent.click(await screen.findByTestId('space-account-link-1'));
    fireEvent.click(await screen.findByTestId('space-account-sheet-detach'));
    fireEvent.click(await screen.findByTestId('space-account-detach-confirm'));
    await waitFor(() => expect(detached).toBe(true), { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('space-account-link-1')).toBeNull(), { timeout: 5000 });
  }, 15_000);

  it('#239 r2: the info sheet names the GLOBAL name and doors into the all-accounts sheet', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    // the space calls it by its OWN name — the global one must still show
    await repo.upsert('accountLink', 's-user', 'link-1', {
      feedSpaceId: 'feed-1',
      accountId: 'feedacct-1',
      type: 'checking',
      displayName: 'Huishouden',
    });
    db.close();

    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
      },
    });

    fireEvent.click(await screen.findByTestId('space-account-link-1'));
    const sheet = await screen.findByTestId('space-account-info');
    // the space's name leads; the global name stands as its own fact
    expect(sheet.textContent).toContain('Global name');
    expect(sheet.textContent).toContain('ING Betaal');

    // the quick link lands on the overview WITH the account's sheet open
    fireEvent.click(screen.getByTestId('space-account-goto-global'));
    await screen.findByTestId('screen-accounts');
    await screen.findByTestId('attach-source');
    expect((await screen.findByTestId('attach-name') as HTMLInputElement).value).toBe('ING Betaal');
  }, 15_000);

  it('#212 r2: the space info sheet types a LINKED account — this space alone, global row untouched', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 's-user', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1', type: 'checking' });
    db.close();

    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
      },
    });

    // the linked row's info sheet carries the SPACE's type row now
    fireEvent.click(await screen.findByTestId('space-account-link-1'));
    await screen.findByTestId('space-account-info');
    fireEvent.click(await screen.findByTestId('account-type-row'));
    fireEvent.click(await screen.findByTestId('account-type-pick-savings'));
    fireEvent.click(await screen.findByTestId('account-type-confirm-confirm'));

    // the fact lands on the LINK; the global account row keeps its own
    const db2 = new MunniDB(USER_TEST_DB);
    await waitFor(async () => {
      expect((await db2.accountLinks.get('link-1'))?.type).toBe('savings');
    }, { timeout: 5000 });
    expect((await db2.accounts.get('feedacct-1'))?.type).toBe('checking');
    db2.close();
  }, 15_000);

  it('#205: the space info sheet shows where the data ends and the newest transaction', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
      dataThroughDate: '2026-06-07',
    });
    // the newest movement is a RAW row in the feed space (#205: raw
    // rows, not the per-space view — that one under-reports)
    await repo.upsert('transaction', 'feed-1', 'feedtx-1', {
      accountId: 'feedacct-1',
      date: '2026-06-10',
      amountCents: -1200,
      currency: 'EUR',
      merchant: 'SHELL',
      txType: 'expense',
    });
    await repo.upsert('accountLink', 's-user', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1', type: 'checking' });
    db.close();

    renderAppAsUser('/spaces/s-user/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
      },
    });

    fireEvent.click(await screen.findByTestId('space-account-link-1'));
    const sheet = await screen.findByTestId('space-account-info');
    expect(sheet.textContent).toContain('Data through');
    expect(sheet.textContent).toContain('2026-06-07');
    expect(sheet.textContent).toContain('Latest transaction');
    await waitFor(() => expect(screen.getByTestId('space-account-info').textContent).toContain('2026-06-10'), { timeout: 5000 });
  }, 15_000);

  it('global sheet lists only attached spaces and detaches from there too', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 's-user', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1' });
    db.close();

    let detached = false;
    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
        'DELETE /spaces/s-user/accounts/srv-1': () => {
          detached = true;
          return {};
        },
      },
    });

    fireEvent.click(await screen.findByTestId('account-row-feedacct-1'));
    // attached spaces render as plain rows with a detach — no checkboxes
    const row = await screen.findByTestId('attach-space-s-user');
    expect(row.querySelector('.mdi-checkbox-marked, .mdi-checkbox-blank-outline')).toBeNull();
    fireEvent.click(screen.getByTestId('attach-detach-s-user'));
    fireEvent.click(await screen.findByTestId('attach-detach-confirm'));
    await waitFor(() => expect(detached).toBe(true), { timeout: 5000 });
    // the sheet empties: the account no longer feeds any space
    await waitFor(() => expect(screen.getByTestId('attach-none')).toBeTruthy(), { timeout: 5000 });
  }, 15_000);

  it('deleting a connected account confirms, calls the server and purges it locally', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    db.close();

    let deleted = false;
    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'DELETE /me/feeds/feed-1': () => {
          deleted = true;
          return { erased: true };
        },
      },
    });

    fireEvent.click(await screen.findByTestId('account-row-feedacct-1'));
    fireEvent.click(await screen.findByTestId('attach-delete'));
    // the X-style direct delete never fires — a confirm sheet asks first
    fireEvent.click(await screen.findByTestId('attach-delete-confirm'));
    await waitFor(() => expect(deleted).toBe(true), { timeout: 5000 });
    // the feed's local rows are purged: the account leaves the overview
    await waitFor(() => expect(screen.queryByTestId('account-row-feedacct-1')).toBeNull(), { timeout: 5000 });
  }, 15_000);

  it('#185: a slow feed delete narrates its server stage in the busy note', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    db.close();

    let release: (() => void) | undefined;
    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        // a hanging server: the delete resolves only when the test says so
        'DELETE /me/feeds/feed-1': () =>
          new Promise((resolve) => {
            release = () => resolve({ erased: true });
          }),
      },
    });

    fireEvent.click(await screen.findByTestId('account-row-feedacct-1'));
    fireEvent.click(await screen.findByTestId('attach-delete'));
    fireEvent.click(await screen.findByTestId('attach-delete-confirm'));
    // a dismissal attempt mid-flight says WHICH stage runs, not just
    // "still running" — the server call is the slow one
    fireEvent.keyDown(window, { key: 'Escape' });
    const note = await screen.findByTestId('sheet-busy-note');
    expect(note.textContent).toContain('Removing bank connection');
    // let the server answer — the delete completes and the row leaves
    release?.();
    await waitFor(() => expect(screen.queryByTestId('account-row-feedacct-1')).toBeNull(), { timeout: 5000 });
  }, 15_000);

  it('adds a manual cash account via the space door (manual is space-scoped now)', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    // the GLOBAL screen offers manual only as a DOOR into the space
    // (user ruling 2026-07-28) — creation happens on the space screen
    fireEvent.click(await screen.findByTestId('chooser-manual-door'));
    // "Add a manual account" opens the type grid directly (redesign ss13)
    fireEvent.click(await screen.findByTestId('space-accounts-add'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-cash'));
    fireEvent.change(screen.getByTestId('chooser-acctform-name'), { target: { value: 'Wallet' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '25,50' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));
    await waitFor(() => expect(screen.getByText('Wallet')).toBeTruthy());
  }, 15_000);

  it('a credit card account stores its balance as a liability, listed under its space', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    fireEvent.click(await screen.findByTestId('chooser-manual-door'));
    fireEvent.click(await screen.findByTestId('space-accounts-add'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-credit'));
    fireEvent.change(screen.getByTestId('chooser-acctform-name'), { target: { value: 'Visa' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));
    await screen.findByText('Visa');
    // the claim is the STORED sign: liabilities keep negative cents
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const rows = await db.accounts.filter((a) => a.name === 'Visa').toArray();
      expect(rows[0]?.balanceCents).toBe(-10_000);
    });
    db.close();
  }, 15_000);

  it('the sign toggle stores an overpaid card POSITIVE; space rows edit in place', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    fireEvent.click(await screen.findByTestId('chooser-manual-door'));
    fireEvent.click(await screen.findByTestId('space-accounts-add'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-credit'));
    fireEvent.change(screen.getByTestId('chooser-acctform-name'), { target: { value: 'Amex' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '100' } });
    // liabilities DEFAULT to −, but the user decides (overpaid card rule)
    fireEvent.click(screen.getByTestId('chooser-acctform-pos'));
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    let id = '';
    await waitFor(async () => {
      const rows = await db.accounts.filter((a) => a.name === 'Amex').toArray();
      expect(rows[0]?.balanceCents).toBe(10_000); // stored POSITIVE
      id = rows[0]?.id ?? '';
    }, { timeout: 5000 });

    // #206: a manual row opens the edit sheet DIRECTLY — the info sheet
    // said nothing the editor doesn't (user ss); feed rows keep it
    fireEvent.click(await screen.findByTestId(`space-account-${id}`));
    expect(screen.queryByTestId('space-account-info')).toBeNull();
    fireEvent.change(await screen.findByTestId('acctedit-name'), { target: { value: 'Amex Gold' } });
    fireEvent.click(screen.getByTestId('acctedit-save'));
    await waitFor(async () => {
      const rows = await db.accounts.filter((a) => a.name === 'Amex Gold').toArray();
      expect(rows).toHaveLength(1);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('renames and deletes an account from the edit sheet', async () => {
    renderApp('/accounts');
    fireEvent.click(await screen.findByTestId('account-row-demo_save'));
    const nameInput = await screen.findByTestId('acctedit-name');
    fireEvent.change(nameInput, { target: { value: 'Rainy day' } });
    fireEvent.click(screen.getByTestId('acctedit-save'));
    await waitFor(() => expect(screen.getByTestId('account-row-demo_save').textContent).toContain('Rainy day'));

    fireEvent.click(screen.getByTestId('account-row-demo_save'));
    // aligned destructive confirm: delete opens the shared danger sheet
    fireEvent.click(await screen.findByTestId('acctedit-delete'));
    fireEvent.click(await screen.findByTestId('acctedit-remove-confirm'));
    await waitFor(() => expect(screen.queryByTestId('account-row-demo_save')).toBeNull());
  });

  it('#176: an Enable Banking-fetched account says so — never "GoCardless"', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('eb-label'), { trackOutbox: false });
    // the server's ingest stamps WHO fetches (#176) — the label follows
    await repo.upsert('account', 'demo_space', 'eb-acc', {
      name: 'ASN via EB',
      type: 'checking',
      source: 'gocardless',
      provider: 'enablebanking',
      currency: 'EUR',
      balanceCents: 0,
      iban: 'NL43ASNB8852368507',
      bankId: 'ASN Bank|NL',
    });
    db.close();

    fireEvent.click(await screen.findByTestId('account-row-eb-acc'));
    await waitFor(() => expect(screen.getByTestId('acctedit-source').textContent).toContain('Enable Banking'));
    expect(screen.getByTestId('acctedit-source').textContent).not.toContain('GoCardless');
  }, 15_000);

  it('#221: a DEFAULT account offers no delete — and its balance edit leaves an adjustment row', async () => {
    renderApp('/accounts');
    // #227: the six defaults sit folded behind the section's toggle
    fireEvent.click(await screen.findByTestId('accounts-defaults-toggle-demo_space'));
    // the demo space is born with its six defaults (eager mint)
    fireEvent.click(await screen.findByTestId('account-row-defaultacct_saving_demo_space'));
    await screen.findByTestId('acctedit-name');
    expect(screen.queryByTestId('acctedit-delete')).toBeNull();

    fireEvent.change(screen.getByTestId('acctedit-balance'), { target: { value: '25' } });
    fireEvent.click(screen.getByTestId('acctedit-save'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.accounts.get('defaultacct_saving_demo_space'))?.balanceCents).toBe(2500);
      const adjustment = await db.transactions
        .filter((t) => t.accountId === 'defaultacct_saving_demo_space' && t.catId === 'balanceAdjustment')
        .first();
      // the delta, recorded with the adjustment category — the ledger
      // stays coherent without a hand on it
      expect(adjustment).toMatchObject({ amountCents: 2500, adjustment: 1, needsReview: 0, txType: 'adjustment' });
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#227: the default pots sit folded — closed by default, the toggle reveals them', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    // folded: no default row in the DOM; the quiet toggle counts them
    expect(screen.queryByTestId('account-row-defaultacct_saving_demo_space')).toBeNull();
    const toggle = await screen.findByTestId('accounts-defaults-toggle-demo_space');
    expect(toggle.textContent).toContain('Show default accounts (');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('account-row-defaultacct_saving_demo_space')).toBeTruthy();
    expect(screen.getByTestId('accounts-defaults-toggle-demo_space').textContent).toContain('Hide default accounts');
    fireEvent.click(screen.getByTestId('accounts-defaults-toggle-demo_space'));
    await waitFor(() => expect(screen.queryByTestId('account-row-defaultacct_saving_demo_space')).toBeNull());
  }, 15_000);

  it('#179: a pending add-account intent opens the manual chooser on arrival', async () => {
    const { setSpaceAddAccountIntent } = await import('@/features/spaces/spaceAccountsHandoff');
    setSpaceAddAccountIntent();
    renderApp('/spaces/demo_space/accounts');
    await screen.findByTestId('screen-space-accounts');
    // the chooser opened by itself, straight on its manual type grid
    expect(await screen.findByTestId('chooser-accttype-cash')).toBeTruthy();
  }, 15_000);

  it('imports a CAMT.053 file: preview, run, result, new account appears', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    const file = new File([CAMT_FIXTURE], 'statement.xml', { type: 'text/xml' });
    Object.defineProperty(input, 'files', { value: [file] });
    fireEvent.change(input);

    const preview = await screen.findByTestId('import-preview');
    expect(preview.textContent).toContain('NL69INGB0123456789');
    expect(preview.textContent).toContain('2 transactions');

    fireEvent.click(screen.getByTestId('import-run'));
    const result = await screen.findByTestId('import-result');
    expect(result.textContent).toContain('Imported 2 transactions, skipped 0 duplicates');
    fireEvent.click(screen.getByTestId('import-close'));
    // the imported IBAN now exists as an account
    await waitFor(() => expect(screen.getByText('NL69INGB0123456789')).toBeTruthy());
  });

  it('rejects a non-CAMT file with the error banner', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['<html>nope</html>'], 'x.xml')] });
    fireEvent.change(input);
    expect(await screen.findByTestId('import-error')).toBeTruthy();
  });

  it('#226 r2: the ING row carries its download route and a real logo image', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-import'));
    const row = await screen.findByTestId('import-bank-ing');
    // the semicolon instruction (the copy the user liked) is the sub line
    expect(row.textContent).toContain('semicolon separated');
    const logo = row.querySelector('img');
    expect(logo?.getAttribute('src') ?? '').toMatch(/ing\.svg|^data:image/);
    // ASN and PayPal rows carry their own download routes
    expect(screen.getByTestId('import-bank-asn').textContent).toContain('CAMT.053 (XML)');
    expect(screen.getByTestId('import-bank-paypal').textContent).toContain('paypal.com');
  });

  it('#226 r2: picking ING then uploading a PayPal CSV asks before importing', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-import'));
    fireEvent.click(await screen.findByTestId('import-bank-ing'));
    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    const uploadPaypal = () => {
      Object.defineProperty(input, 'files', {
        value: [new File([PAYPAL_CSV], 'Download.CSV', { type: 'text/csv' })],
        configurable: true, // re-defined on the re-upload below
      });
      fireEvent.change(input);
    };
    uploadPaypal();

    // the ask names the picked bank and the detected format — no preview yet
    const sheet = await screen.findByTestId('import-mismatch-sheet');
    expect(sheet.textContent).toContain('ING');
    expect(sheet.textContent).toContain('PayPal CSV');
    expect(screen.queryByTestId('import-preview')).toBeNull();

    // Cancel discards the file: no preview, back on the bank picker
    fireEvent.click(screen.getByTestId('import-mismatch-cancel'));
    await waitFor(() => expect(screen.queryByTestId('import-mismatch-sheet')).toBeNull());
    expect(screen.queryByTestId('import-preview')).toBeNull();

    // re-pick + re-upload, then Continue → the normal preview step
    fireEvent.click(screen.getByTestId('import-bank-ing'));
    uploadPaypal();
    fireEvent.click(await screen.findByTestId('import-mismatch-continue'));
    const preview = await screen.findByTestId('import-preview');
    expect(preview.textContent).toContain('PAYPALMEEXAMPLECOM');
  });

  it('#227 r2: tapping an echo row flashes the jumped-to account row, then the flash fades', async () => {
    const first = renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 'demo_space', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1' });
    db.close();
    first.unmount();

    renderApp('/accounts');
    fireEvent.click(await screen.findByTestId('account-echo-demo_space-feedacct-1'));
    // the jump target wears the flash marker the moment the echo fires…
    const target = document.getElementById('acct-row-feedacct-1')!;
    expect(target.getAttribute('data-flash')).toBe('1');
    // …and sheds it once the pulse ends (the setTimeout cleanup)
    await waitFor(() => expect(target.getAttribute('data-flash')).toBeNull(), { timeout: 4000 });
  }, 15_000);

  it('#269: a PLAIN manual balance edit warns with the delta and mints the adjustment row', async () => {
    renderApp('/accounts');
    // demo_save is an ordinary manual account — no defaultFor (#221's
    // defaults-only minting grew to every manual account)
    fireEvent.click(await screen.findByTestId('account-row-demo_save'));
    await screen.findByTestId('acctedit-balance');
    // untouched field: no note
    expect(screen.queryByTestId('acctedit-adjust-note')).toBeNull();
    fireEvent.change(screen.getByTestId('acctedit-balance'), { target: { value: '8200' } });
    // the note names the exact signed delta the save will record
    expect((await screen.findByTestId('acctedit-adjust-note')).textContent).toContain('+€50.00');
    fireEvent.click(screen.getByTestId('acctedit-save'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      expect((await db.accounts.get('demo_save'))?.balanceCents).toBe(820_000);
      const adjustment = await db.transactions
        .filter((t) => t.accountId === 'demo_save' && t.catId === 'balanceAdjustment')
        .first();
      expect(adjustment).toMatchObject({ amountCents: 5000, adjustment: 1, needsReview: 0, txType: 'adjustment' });
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('#278: the unattached import result names the space the attach button targets', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { feedSpaceId } = await import('@/domain/feedIds');
    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        // the fixture's feed must stay reachable or the engine purges it
        'GET /me/spaces': () => ['s-user', feedSpaceId('NL69INGB0123456789')],
        'GET /me/feeds': () => [],
        'POST /feeds': () => ({}),
      },
    });
    await screen.findByTestId('screen-accounts');
    const input = screen.getByTestId('accounts-import-input') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File([CAMT_FIXTURE], 'statement.xml', { type: 'text/xml' })] });
    fireEvent.change(input);
    fireEvent.click(await screen.findByTestId('import-run'));

    await screen.findByTestId('import-result', {}, { timeout: 10_000 });
    // #204's note stands — and now SAYS which space attaching lands in
    expect(await screen.findByTestId('import-unattached-note')).toBeTruthy();
    expect(screen.getByTestId('import-attach-target').textContent).toContain('"Personal"');
  }, 20_000);

  it('#279: deleting a global account sweeps member-space overlays and legacy own rows', async () => {
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const { txMetaId } = await import('@/domain/feedIds');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    // the feed's raw row + this space's OVERLAY for it — engine.purgeSpace
    // is feed-keyed, so the overlay used to survive as invisible junk
    await repo.upsert('transaction', 'feed-1', 'rawtx-1', {
      accountId: 'feedacct-1',
      date: '2026-06-10',
      amountCents: -1200,
      currency: 'EUR',
      merchant: 'SHELL',
      txType: 'expense',
    });
    const metaId = txMetaId('s-user', 'rawtx-1');
    await repo.upsert('txMeta', 's-user', metaId, { txId: 'rawtx-1', txType: 'expense', needsReview: 0, catId: 'groceries' });
    // a legacy merged-import leftover: the member space's OWN row on the
    // deleted account — it kept rendering with a dangling account
    await repo.upsert('transaction', 's-user', 'legacy-1', {
      accountId: 'feedacct-1',
      date: '2026-05-01',
      amountCents: -700,
      currency: 'EUR',
      merchant: 'OLD PATH',
      txType: 'expense',
    });
    await repo.upsert('accountLink', 's-user', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1' });
    db.close();

    renderAppAsUser('/accounts', {
      spaces: [{ id: 's-user', name: 'Personal' }],
      api: {
        'GET /health': () => ({ status: 'ok', capabilities: { gocardless: false } }),
        'GET /me/spaces': () => ['s-user', 'feed-1'],
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'GET /spaces/s-user/accounts': () => [{ id: 'srv-1', feedSpaceId: 'feed-1', accountId: 'feedacct-1' }],
        'DELETE /me/feeds/feed-1': () => ({ erased: true }),
      },
    });

    fireEvent.click(await screen.findByTestId('account-row-feedacct-1'));
    fireEvent.click(await screen.findByTestId('attach-delete'));
    fireEvent.click(await screen.findByTestId('attach-delete-confirm'));
    await waitFor(() => expect(screen.queryByTestId('account-row-feedacct-1')).toBeNull(), { timeout: 5000 });

    // both remnants are TOMBSTONED (synced deletes), not merely dropped
    const check = new MunniDB(USER_TEST_DB);
    await waitFor(async () => {
      expect((await check.txMeta.get(metaId))?.deleted).toBe(1);
      expect((await check.transactions.get('legacy-1'))?.deleted).toBe(1);
    }, { timeout: 5000 });
    check.close();
  }, 20_000);
});

describe('reconcile suggestion (master plan: linked is the truth)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('offers a reconcile pass on a mixed-source account, reviews, and deletes judged imports', async () => {
    const first = renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('rec-ui'), { trackOutbox: false });
    const raw = { accountId: 'demo_main', currency: 'EUR', txType: 'expense' as const, needsReview: 0 as const };
    // the connection's truth + one matched import, one mismatch, one keeper
    await repo.upsert('transaction', 'demo_space', 'RL1', { ...raw, date: '2026-06-01', amountCents: -5000, merchant: 'EDGE', importRef: 'REF-EDGE' });
    await repo.upsert('transaction', 'demo_space', 'RL2', { ...raw, date: '2026-06-10', amountCents: -1200, merchant: 'SHELL', importRef: 'REF-B' });
    await repo.upsert('transaction', 'demo_space', 'RL3', { ...raw, date: '2026-06-20', amountCents: -300, merchant: 'END', importRef: 'REF-END' });
    await repo.upsert('transaction', 'demo_space', 'RI1', { ...raw, date: '2026-06-10', amountCents: -1200, merchant: 'Shell station', importRef: 'ing:u:1' });
    await repo.upsert('transaction', 'demo_space', 'RI2', { ...raw, date: '2026-06-12', amountCents: -999, merchant: 'GHOST', importRef: 'ing:u:2' });
    await repo.upsert('transaction', 'demo_space', 'RI3', { ...raw, date: '2023-01-05', amountCents: -700, merchant: 'OLD', importRef: 'ing:u:3' });
    db.close();
    first.unmount();

    renderApp('/accounts');
    // the suggestion names the mixed-source account and its import count
    fireEvent.click(await screen.findByTestId('account-reconcile-demo_main', {}, { timeout: 5000 }));

    // full review: the match (checked for migration), the mismatch, the keeper note
    await screen.findByTestId('reconcile-review', {}, { timeout: 5000 });
    expect(screen.getByTestId('reconcile-match-RI1')).toBeTruthy();
    expect((screen.getByTestId('reconcile-migrate-RI1') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('reconcile-mismatch-RI2').textContent).toContain('GHOST');
    expect(screen.getByTestId('reconcile-kept').textContent).toContain('1');

    fireEvent.click(screen.getByTestId('reconcile-confirm'));
    await screen.findByTestId('reconcile-done', {}, { timeout: 5000 });

    const check = new MunniDB('munni_demo');
    expect((await check.transactions.get('RI1'))?.deleted).toBe(1);
    expect((await check.transactions.get('RI2'))?.deleted).toBe(1);
    expect((await check.transactions.get('RI3'))?.deleted).toBe(0);
    check.close();
  }, 20_000);
});

describe('import batches (master plan IB)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the attach sheet lists statement uploads and rolls one back — only ITS rows fall', async () => {
    const first = renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('ib-ui'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'camt053',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
    });
    await repo.upsert('accountLink', 'demo_space', 'link-1', { feedSpaceId: 'feed-1', accountId: 'feedacct-1', attachedByName: 'Okkes' });
    const raw = { accountId: 'feedacct-1', currency: 'EUR', txType: 'expense' as const, needsReview: 0 as const };
    // one two-row batch (with an uploader name) and one row a LATER upload
    // merely re-encountered — it keeps its first batch and must survive
    await repo.upsert('transaction', 'demo_space', 'B1a', { ...raw, date: '2026-06-03', amountCents: -100, merchant: 'A', importRef: 'ing:b:1', importBatchId: 'batch-1', importedBy: 'Okkes' });
    await repo.upsert('transaction', 'demo_space', 'B1b', { ...raw, date: '2026-06-07', amountCents: -200, merchant: 'B', importRef: 'ing:b:2', importBatchId: 'batch-1', importedBy: 'Okkes' });
    await repo.upsert('transaction', 'demo_space', 'B2a', { ...raw, date: '2026-06-09', amountCents: -300, merchant: 'C', importRef: 'ing:b:3', importBatchId: 'batch-2' });
    db.close();
    first.unmount();

    renderApp('/accounts');
    fireEvent.click(await screen.findByTestId('account-row-feedacct-1', {}, { timeout: 5000 }));
    const list = await screen.findByTestId('attach-imports', {}, { timeout: 5000 });
    // batch-1 spans its rows' dates and names its uploader
    expect(list.textContent).toContain('2026-06-03');
    expect(list.textContent).toContain('2026-06-07');
    expect(list.textContent).toContain('Okkes');

    fireEvent.click(screen.getByTestId('attach-rollback-batch-1'));
    fireEvent.click(await screen.findByTestId('attach-rollback-confirm', {}, { timeout: 5000 }));
    // batch-1's rows tombstone; batch-2's row (and its list entry) survive
    await waitFor(() => expect(screen.queryByTestId('attach-rollback-batch-1')).toBeNull(), { timeout: 5000 });
    expect(screen.getByTestId('attach-rollback-batch-2')).toBeTruthy();
    const check = new MunniDB('munni_demo');
    expect((await check.transactions.get('B1a'))?.deleted).toBe(1);
    expect((await check.transactions.get('B1b'))?.deleted).toBe(1);
    expect((await check.transactions.get('B2a'))?.deleted).toBe(0);
    check.close();
  }, 20_000);
});
