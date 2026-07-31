// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';

/** the merged Loan form (arc 3): name + current value are the whole ask;
 *  the backing account mints itself by default */
async function createDebt(name: string, current: string, apr?: string, payment?: string, original?: string) {
  fireEvent.click(await screen.findByTestId('debts-add'));
  await screen.findByTestId('debtform-name');
  fireEvent.change(screen.getByTestId('debtform-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('debtform-current'), { target: { value: current } });
  fireEvent.change(screen.getByTestId('debtform-original'), { target: { value: original ?? current } });
  if (apr) fireEvent.change(screen.getByTestId('debtform-apr'), { target: { value: apr } });
  if (payment) fireEvent.change(screen.getByTestId('debtform-payment'), { target: { value: payment } });
  fireEvent.click(screen.getByTestId('debtform-save'));
  await waitFor(() => {
    expect(document.querySelector('[data-testid^="debt-card-"]')).toBeTruthy();
  });
  return document.querySelector('[data-testid^="debt-card-"]')!;
}

const demoRepo = (db: MunniDB) => new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });

describe('Debts (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the merged Loan form mints the backing account; cadence + note stored', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await screen.findByTestId('debts-empty');

    fireEvent.click(screen.getByTestId('debts-add'));
    await screen.findByTestId('debtform-name');
    fireEvent.change(screen.getByTestId('debtform-name'), { target: { value: 'Student loan' } });
    fireEvent.change(screen.getByTestId('debtform-original'), { target: { value: '12000' } });
    // save refuses until the CURRENT value anchors the loan (arc 3)
    expect((screen.getByTestId('debtform-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId('debtform-current'), { target: { value: '10000' } });
    fireEvent.change(screen.getByTestId('debtform-iban'), { target: { value: 'NL77LOAN0000000077' } });
    fireEvent.change(screen.getByTestId('debtform-apr'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('debtform-payment'), { target: { value: '120' } });
    // weekly cadence (arc 3): the projection follows it
    fireEvent.click(screen.getByTestId('debtform-every-week'));
    fireEvent.change(screen.getByTestId('debtform-note'), { target: { value: 'DUO, samen met Kim' } });
    fireEvent.click(screen.getByTestId('debtform-save'));

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="debt-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain('Student loan');
    expect(card.textContent).toMatch(/10.000/); // current value is the remaining truth
    expect(card.textContent).toMatch(/of.*12.000/); // the optional original adds the story
    expect(card.textContent).toMatch(/week/);
    expect(card.textContent).toMatch(/free by/);

    // ONE save minted account + debt together
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const debt = (await db.debts.toArray()).find((d) => d.name === 'Student loan');
      expect(debt).toMatchObject({ paymentEvery: 'week', paymentCents: 12_000, note: 'DUO, samen met Kim' });
      const account = await db.accounts.get(debt!.accountId!);
      expect(account).toMatchObject({ type: 'loan', source: 'manual', balanceCents: -1_000_000, iban: 'NL77LOAN0000000077' });
    }, { timeout: 5000 });
    // weekly €120 ≈ €520/month on the overview (cadence-normalized)
    expect(screen.getByTestId('debts-overview').textContent).toMatch(/520/);
    db.close();
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
    // the manual backing account seeds the anchor field with its balance
    await waitFor(() => expect((screen.getByTestId('debtform-current') as HTMLInputElement).value).toBe('10000.00'));
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

  it('bare debt payments gather in the virtual card and assign to a loan', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createDebt('Car loan', '5000');
    const debtId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    // two counterparty-less debt payments (the arc-2 bare label)
    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    const base = { accountId: 'demo_main', currency: 'EUR', needsReview: 0 as const, txType: 'debtPayment' as const, catId: 'loanRepayment' };
    await repo.upsert('transaction', 'demo_space', 'bare1', { ...base, date: '2026-07-01', amountCents: -15_000, merchant: 'Aflossing' });
    await repo.upsert('transaction', 'demo_space', 'bare2', { ...base, date: '2026-07-15', amountCents: -15_000, merchant: 'Aflossing' });

    // the virtual card sums them — a computed bucket, not a stored debt
    const unassigned = await screen.findByTestId('debts-unassigned');
    expect(unassigned.textContent).toContain('Unassigned');
    await waitFor(() => expect(screen.getByTestId('debts-unassigned').textContent).toMatch(/300/), { timeout: 5000 });
    fireEvent.click(unassigned);
    await screen.findByTestId('debts-unassigned-list');
    fireEvent.click(await screen.findByTestId('tx-row-bare1'));
    await screen.findByTestId('debts-assign-options');
    fireEvent.click(screen.getByTestId(`debts-assign-${debtId}`));

    // the link files it under the loan; the bucket shrinks to the other row
    const debt = (await db.debts.toArray()).find((d) => d.id === debtId)!;
    await waitFor(async () => {
      expect((await db.transactions.get('bare1'))?.linkedAccountId).toBe(debt.accountId);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('empty payment fields estimate from ≥3 payments; the add-payment door pre-stages the loan', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createDebt('Car loan', '5000');
    const debtId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    const debt = (await db.debts.toArray()).find((d) => d.id === debtId)!;
    const base = { accountId: 'demo_main', currency: 'EUR', needsReview: 0 as const, txType: 'debtPayment' as const, catId: 'loanRepayment', linkedAccountId: debt.accountId! };
    await repo.upsert('transaction', 'demo_space', 'pay1', { ...base, date: '2026-04-01', amountCents: -25_000, merchant: 'Termijn' });
    await repo.upsert('transaction', 'demo_space', 'pay2', { ...base, date: '2026-05-01', amountCents: -25_000, merchant: 'Termijn' });
    await repo.upsert('transaction', 'demo_space', 'pay3', { ...base, date: '2026-06-01', amountCents: -25_000, merchant: 'Termijn' });

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    // "estimated from payments": median amount + interval, never stored
    const estimate = await screen.findByTestId('debtdetail-estimate');
    expect(estimate.textContent).toMatch(/250/);
    expect(estimate.textContent).toMatch(/estimated from payments/);
    // the estimate also powers the projection despite empty explicit fields
    expect(screen.getByTestId('debtdetail-projection')).toBeTruthy();

    // the add-payment door opens the manual form staged onto this loan
    fireEvent.click(screen.getByTestId('debtdetail-add-payment'));
    await screen.findByTestId('txform-save');
    await waitFor(() => expect(screen.getByTestId('txform-kind').textContent).toContain('Debt Payment'));
    expect(screen.getByTestId('txform-counter').textContent).toContain('Car loan');
    expect((screen.getByTestId('txform-merchant') as HTMLInputElement).value).toBe('Car loan');
    db.close();
  }, 15_000);
});
