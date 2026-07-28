// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

const openForm = async () => {
  renderApp('/transactions');
  await screen.findByTestId('tx-list');
  fireEvent.click(screen.getByTestId('tx-add'));
  await screen.findByTestId('txform-save');
  // the account chips load via liveQuery; without an account save can never enable
  await screen.findByTestId('txform-account-demo_main');
};

describe('TxFormSheet (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('save stays disabled until amount and merchant are valid', async () => {
    await openForm();
    const save = screen.getByTestId('txform-save') as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker' } });
    expect(save.disabled).toBe(true); // still no amount

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '0' } });
    expect(save.disabled).toBe(true); // zero is not a transaction

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '4,50' } });
    await waitFor(() => expect(save.disabled).toBe(false));
  });

  it('adds an expense with a picked category and shows it in the list', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '12,34' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bakker Bart' } });

    // the category row opens the UNIFIED editor (same as review) —
    // pick through its per-row picker, Done stages the single category
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('split-cat-0'));
    fireEvent.click(await screen.findByTestId('catpicker-groceries'));
    fireEvent.click(await screen.findByTestId('split-save'));
    await waitFor(() => expect(screen.getByTestId('txform-category').textContent).toContain('Grocery'));

    fireEvent.click(screen.getByTestId('txform-save'));
    // generous timeout: coverage instrumentation slows the liveQuery round-trip
    await waitFor(
      () => {
        const row = [...screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]')].find((r) =>
          r.textContent?.includes('Bakker Bart'),
        );
        expect(row).toBeTruthy();
        expect(row!.textContent).toContain('-€12.34');
        expect(row!.textContent).toContain('Grocery');
      },
      { timeout: 5000 },
    );
    // coverage instrumentation pushes this flow past vitest's 5s default
  }, 15_000);

  it('no manual account: the form explains itself and doors to accounts', async () => {
    const { renderAppAsUser, USER_TEST_DB } = await import('@/test/harness');
    indexedDB.deleteDatabase(USER_TEST_DB);
    // a user space with ZERO writable accounts (no seed)
    renderAppAsUser('/transactions', { spaces: [{ id: 's-user', name: 'Personal' }] });
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    // the empty state replaces the form and the CTA lands on accounts
    expect(await screen.findByTestId('txform-no-accounts')).toBeTruthy();
    fireEvent.click(screen.getByTestId('txform-add-account'));
    expect(await screen.findByTestId('screen-accounts')).toBeTruthy();
  }, 15_000);

  it('a manual expense adjusts the account balance live (user bug: it froze)', async () => {
    await openForm();
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    const before = (await db.accounts.get('demo_main'))!.balanceCents;

    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Markt' } });
    fireEvent.click(screen.getByTestId('txform-save'));

    await waitFor(async () => {
      expect((await db.accounts.get('demo_main'))!.balanceCents).toBe(before - 5000);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('a transfer kind demands its counterparty; the counterparty derives the type', async () => {
    await openForm();
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '25,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Naar spaarpot' } });

    // the kind row sits on the form (user simplification); picking
    // Transfer opens the mandatory counterparty picker right away
    fireEvent.click(screen.getByTestId('txform-kind'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-transfer'));
    await screen.findByTestId('counter-accounts');
    // save is blocked while the counterparty is missing
    expect((screen.getByTestId('txform-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('counter-pick-demo_save'));
    // the savings counterparty derives Saving on the kind row
    await waitFor(() => expect(screen.getByTestId('txform-kind').textContent).toContain('Saving'));
    expect(screen.getByTestId('txform-counter').textContent).toContain('Demo Savings');
    expect((screen.getByTestId('txform-save') as HTMLButtonElement).disabled).toBe(false);

    // back to Standard: the counterparty row leaves with the kind
    fireEvent.click(screen.getByTestId('txform-kind'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-standard'));
    await waitFor(() => expect(screen.queryByTestId('txform-counter')).toBeNull());

    // adjustment saves as a correction row (manual-only third kind)
    fireEvent.click(screen.getByTestId('txform-kind'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-adjustment'));
    await waitFor(() => expect(screen.getByTestId('txform-kind').textContent).toContain('Adjustment'));
    fireEvent.click(screen.getByTestId('txform-save'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const row = (await db.transactions.toArray()).find((r) => r.merchant === 'Naar spaarpot');
      expect(row?.txType).toBe('adjustment');
      expect(row?.linkedAccountId).toBeFalsy();
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('the counterparty picker searches and quick-creates a missing account', async () => {
    await openForm();
    fireEvent.click(screen.getByTestId('txform-kind'));
    await screen.findByTestId('txkind-options');
    fireEvent.click(screen.getByTestId('txkind-transfer'));
    await screen.findByTestId('counter-accounts');

    // search narrows; no match offers the create door (user request:
    // "search … and create one quickly if it does not exist")
    fireEvent.change(screen.getByTestId('counter-search'), { target: { value: 'Vakantiepot' } });
    await screen.findByTestId('counter-empty');
    fireEvent.click(screen.getByTestId('counter-create'));
    await screen.findByTestId('counter-create-form');
    fireEvent.click(screen.getByTestId('counter-newtype-savings'));
    fireEvent.click(screen.getByTestId('counter-create-save'));

    // the fresh manual account IS the counterparty; savings → Saving
    await waitFor(() => expect(screen.getByTestId('txform-counter').textContent).toContain('Vakantiepot'));
    expect(screen.getByTestId('txform-kind').textContent).toContain('Saving');
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const made = (await db.accounts.toArray()).find((a) => a.name === 'Vakantiepot');
      expect(made).toMatchObject({ type: 'savings', source: 'manual', balanceCents: 0 });
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('a fully synced (open banking) account is never offered for manual rows', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    // make the demo checking account look bank-synced
    const [{ MunniDB }, { DexieBackend }, { Repo }, { HlcClock }] = await Promise.all([
      import('@/db/schema'),
      import('@/db/backend'),
      import('@/db/repo'),
      import('@/sync/hlc'),
    ]);
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('gc'), { trackOutbox: false });
    await repo.upsert('account', 'demo_space', 'demo_main', { source: 'gocardless' });
    db.close();

    fireEvent.click(screen.getByTestId('tx-add'));
    await screen.findByTestId('txform-save');
    await screen.findByTestId('txform-account-demo_save'); // the manual ones stay
    // the cross-connection write lands via a live re-emission — await it
    await waitFor(() => expect(screen.queryByTestId('txform-account-demo_main')).toBeNull(), { timeout: 5000 });
  });

  it('the income toggle stores a positive amount', async () => {
    await openForm();
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '50' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Refund BV' } });
    fireEvent.click(screen.getByTestId('txform-save'));
    await waitFor(
      () => {
        const row = [...screen.getByTestId('tx-list').querySelectorAll('[data-testid^="tx-row-"]')].find((r) =>
          r.textContent?.includes('Refund BV'),
        );
        expect(row!.textContent).toContain('+€50.00');
      },
      { timeout: 5000 },
    );
  });
});
