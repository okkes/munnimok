// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CAMT_FIXTURE } from '@/test/camt-fixture';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';

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
    // to the demo space via a link mirror — the global overview must show
    // "via <space>" and tapping opens attach management, not the editor
    const first = renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(db, new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('account', 'feed-1', 'feedacct-1', {
      name: 'ING Betaal',
      type: 'checking',
      source: 'gocardless',
      currency: 'EUR',
      balanceCents: 5000,
      iban: 'NL69INGB0123456789',
      lastSyncedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
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
    expect(screen.getByTestId('account-via-feedacct-1').textContent).toContain('Demo');
    // when the bank last answered (user request)
    expect(screen.getByTestId('account-synced-feedacct-1').textContent).toContain('minutes ago');

    fireEvent.click(row);
    expect(await screen.findByTestId('attach-spaces')).toBeTruthy();
    // the demo space renders as attached (checkbox on)
    expect(screen.getByTestId('attach-space-demo_space')).toBeTruthy();
    expect(screen.queryByTestId('acctedit-name')).toBeNull(); // not the editor
  });

  it('attach checkboxes update live while the sheet stays open', async () => {
    // user identity: the toggle writes the accountLink mirror to Dexie —
    // the checkbox must flip immediately (user bug: it only refreshed
    // after leaving and re-entering)
    indexedDB.deleteDatabase(USER_TEST_DB);
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(db, new HlcClock('t'), { trackOutbox: false });
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
        'GET /me/feeds': () => [{ feedSpaceId: 'feed-1' }],
        'POST /spaces/s-user/accounts': () => ({}),
      },
    });

    fireEvent.click(await screen.findByTestId('account-row-feedacct-1'));
    const row = await screen.findByTestId('attach-space-s-user');
    expect(row.querySelector('.mdi-checkbox-blank-outline')).toBeTruthy();

    fireEvent.click(row);
    // no close/reopen: the live link row flips the checkbox in place
    await waitFor(() => expect(row.querySelector('.mdi-checkbox-marked')).toBeTruthy(), { timeout: 5000 });
  }, 15_000);

  it('adds a manual cash account through the type grid', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    fireEvent.click(await screen.findByTestId('accttype-cash'));
    fireEvent.change(screen.getByTestId('acctform-name'), { target: { value: 'Wallet' } });
    fireEvent.change(screen.getByTestId('acctform-balance'), { target: { value: '25,50' } });
    fireEvent.click(screen.getByTestId('acctform-save'));
    await waitFor(() => expect(screen.getByText('Wallet')).toBeTruthy());
  });

  it('a credit card account stores its balance as a liability', async () => {
    renderApp('/accounts');
    await screen.findByTestId('account-row-demo_main');
    fireEvent.click(screen.getByTestId('accounts-add'));
    fireEvent.click(await screen.findByTestId('accttype-credit'));
    fireEvent.change(screen.getByTestId('acctform-name'), { target: { value: 'Visa' } });
    fireEvent.change(screen.getByTestId('acctform-balance'), { target: { value: '100' } });
    fireEvent.click(screen.getByTestId('acctform-save'));
    // renders under Liabilities with a negative amount
    const row = await screen.findByText('Visa');
    expect(row.closest('button')!.textContent).toContain('-€100.00');
  });

  it('renames and deletes an account from the edit sheet', async () => {
    renderApp('/accounts');
    fireEvent.click(await screen.findByTestId('account-row-demo_save'));
    const nameInput = await screen.findByTestId('acctedit-name');
    fireEvent.change(nameInput, { target: { value: 'Rainy day' } });
    fireEvent.click(screen.getByTestId('acctedit-save'));
    await waitFor(() => expect(screen.getByTestId('account-row-demo_save').textContent).toContain('Rainy day'));

    fireEvent.click(screen.getByTestId('account-row-demo_save'));
    fireEvent.click(await screen.findByTestId('acctedit-delete'));
    await waitFor(() => expect(screen.queryByTestId('account-row-demo_save')).toBeNull());
  });

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
});
