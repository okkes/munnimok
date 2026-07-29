// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

async function createDebt(name: string, original: string, apr?: string, payment?: string) {
  fireEvent.click(await screen.findByTestId('debts-add'));
  await screen.findByTestId('debtform-name');
  fireEvent.change(screen.getByTestId('debtform-name'), { target: { value: name } });
  // a debt is always backed by a loan account now — quick-create one
  fireEvent.change(screen.getByTestId('debtform-account'), { target: { value: '__new__' } });
  fireEvent.change(screen.getByTestId('debtform-original'), { target: { value: original } });
  if (apr) fireEvent.change(screen.getByTestId('debtform-apr'), { target: { value: apr } });
  if (payment) fireEvent.change(screen.getByTestId('debtform-payment'), { target: { value: payment } });
  fireEvent.click(screen.getByTestId('debtform-save'));
  await waitFor(() => {
    expect(document.querySelector('[data-testid^="debt-card-"]')).toBeTruthy();
  });
  return document.querySelector('[data-testid^="debt-card-"]')!;
}

describe('Debts (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('creates a manual debt; card and overview carry the payoff story', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await screen.findByTestId('debts-empty');

    fireEvent.click(screen.getByTestId('debts-add'));
    await screen.findByTestId('debtform-name');
    fireEvent.change(screen.getByTestId('debtform-name'), { target: { value: 'Student loan' } });
    fireEvent.change(screen.getByTestId('debtform-original'), { target: { value: '10000' } });
    // save refuses until a loan account backs the debt (user rule)
    expect((screen.getByTestId('debtform-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('debtform-account'), { target: { value: '__new__' } });
    fireEvent.change(screen.getByTestId('debtform-apr'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('debtform-payment'), { target: { value: '500' } });
    fireEvent.click(screen.getByTestId('debtform-save'));

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="debt-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain('Student loan');
    expect(card.textContent).toMatch(/10.000/);
    expect(card.textContent).toMatch(/free by/);
    const overview = screen.getByTestId('debts-overview');
    expect(overview.textContent).toMatch(/10.000/);
    expect(overview.textContent).toMatch(/500/);
  }, 15_000);

  it('detail projects the payoff; edit round-trips; delete leaves cleanly', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createDebt('Student loan', '10000', '12', '500');

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    expect(screen.getByTestId('debtdetail-remaining').textContent).toMatch(/10.000/);
    expect(screen.getByTestId('debtdetail-projection').textContent).toMatch(/interest/);

    // edit opens prefilled and saves a faster payment
    fireEvent.click(screen.getByTestId('debtdetail-edit'));
    await waitFor(() => expect((screen.getByTestId('debtform-name') as HTMLInputElement).value).toBe('Student loan'));
    fireEvent.change(screen.getByTestId('debtform-payment'), { target: { value: '1000' } });
    fireEvent.click(screen.getByTestId('debtform-save'));
    // the sheet's onClose commits after the async save — reopening before
    // it lands would get shut by the stale close (CI-only race)
    await waitFor(() => expect(screen.queryByTestId('debtform-delete')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('debtdetail-projection')).toBeTruthy());

    // two-tap delete: the orphaned detail hands back to the list
    fireEvent.click(screen.getByTestId('debtdetail-edit'));
    fireEvent.click(await screen.findByTestId('debtform-delete'));
    fireEvent.click(screen.getByTestId('debtform-delete'));
    await screen.findByTestId('debts-empty');
  }, 15_000);

  it("the recurring form's Debt kind asks fullscreen first, then hands off prefilled", async () => {
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    fireEvent.click(await screen.findByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Car loan' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '250' } });
    // the chip opens Mina's fullscreen ask (2026-07-29: the in-screen
    // note was hidden behind the auto-opened sheet) — Stay returns to
    // the untouched form, Continue performs the handoff
    fireEvent.click(screen.getByTestId('recform-kind-debt'));
    await screen.findByTestId('mina-debt-handoff');
    fireEvent.click(screen.getByTestId('mina-debt-handoff-stay'));
    await waitFor(() => expect(screen.queryByTestId('mina-debt-handoff')).toBeNull());
    expect((screen.getByTestId('recform-name') as HTMLInputElement).value).toBe('Car loan');

    fireEvent.click(screen.getByTestId('recform-kind-debt'));
    await screen.findByTestId('mina-debt-handoff');
    fireEvent.click(screen.getByTestId('mina-debt-handoff-continue'));
    // lands on debts with the create sheet prefilled from the form
    await screen.findByTestId('screen-debts');
    await waitFor(() => expect((screen.getByTestId('debtform-name') as HTMLInputElement).value).toBe('Car loan'));
    expect((screen.getByTestId('debtform-original') as HTMLInputElement).value).toBe('250.00');
  }, 15_000);

  it('the home block totals the debts; the settings row reaches debts', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await createDebt('Car loan', '5000', undefined, '250');

    cleanup();
    renderApp('/home');
    const block = await screen.findByTestId('home-debts', {}, { timeout: 5000 });
    expect(block.textContent).toMatch(/5.000/);
    fireEvent.click(block);
    await screen.findByTestId('screen-debts');

    cleanup();
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-debts-row'));
    await screen.findByTestId('screen-debts');
  }, 15_000);
});
