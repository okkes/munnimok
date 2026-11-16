// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';

async function createLoan(name: string, current: string, apr?: string, payment?: string, original?: string) {
  fireEvent.click(await screen.findByTestId('debts-add'));
  fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
  fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: current } });
  if (original) fireEvent.change(screen.getByTestId('chooser-acctform-original'), { target: { value: original } });
  if (apr) fireEvent.change(screen.getByTestId('chooser-acctform-apr'), { target: { value: apr } });
  if (payment) fireEvent.change(screen.getByTestId('chooser-acctform-payment'), { target: { value: payment } });
  fireEvent.click(screen.getByTestId('chooser-acctform-save'));
  await waitFor(() => {
    expect(document.querySelector('[data-testid^="debt-card-"]')).toBeTruthy();
  });
  // creation auto-offers matching payments only when history holds candidates (#286); these seeds start empty
  expect(screen.queryByTestId('loanmatch-list')).toBeNull();
  return document.querySelector('[data-testid^="debt-card-"]')!;
}

/** A phone's number field hands the page an empty value for text it does not read as a number, and the test DOM does not: this applies that rule. */
const typeOnAPhone = (input: HTMLElement, text: string) => {
  const refused = (input as HTMLInputElement).type === 'number' && !/^\d*\.?\d+$/.test(text);
  fireEvent.change(input, { target: { value: refused ? '' : text } });
};

const demoRepo = (db: MunniDB) => new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });

function isoDayOffset(deltaDays: number): string {
  const d = new Date(Date.now() + deltaDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const seedPayment = (repo: Repo, id: string, date: string, cents = -15_000) =>
  repo.upsert('transaction', 'demo_space', id, {
    accountId: 'demo_main', date, amountCents: cents, merchant: 'Aflossing',
    currency: 'EUR', needsReview: 0, catId: 'loanRepayment',
  });

describe('Debts (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('the Debts + mints a loan account carrying the whole story', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await screen.findByTestId('debts-empty');

    fireEvent.click(screen.getByTestId('debts-add'));
    await screen.findByTestId('chooser-accttype-loan');
    expect(screen.queryByTestId('chooser-accttype-cash')).toBeNull();
    fireEvent.click(screen.getByTestId('chooser-accttype-loan'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Student loan' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-original'), { target: { value: '12000' } });
    // save refuses until the current value anchors the loan, naming the missing amount (#195)
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));
    expect(await screen.findByTestId('chooser-acctform-save-blocker')).toBeTruthy();
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '10000' } });
    await waitFor(() => expect(screen.queryByTestId('chooser-acctform-save-blocker')).toBeNull());
    fireEvent.change(screen.getByTestId('chooser-acctform-iban'), { target: { value: 'NL77LOAN0000000077' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-apr'), { target: { value: '12' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-payment'), { target: { value: '120' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-every-custom'));
    fireEvent.change(screen.getByTestId('chooser-acctform-every-unit'), { target: { value: 'week' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-note'), { target: { value: 'DUO, samen met Kim' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="debt-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain('Student loan');
    expect(card.textContent).toMatch(/10.000/); // the balance is the remaining truth
    expect(card.textContent).toMatch(/of.*12.000/);
    expect(card.textContent).toMatch(/week/);
    expect(card.textContent).toMatch(/free by/);

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const account = (await db.accounts.toArray()).find((a) => a.name === 'Student loan');
      expect(account).toMatchObject({
        type: 'loan',
        source: 'manual',
        balanceCents: -1_000_000,
        iban: 'NL77LOAN0000000077',
        originalCents: 1_200_000,
        interestPctYear: 12,
        paymentCents: 12_000,
        paymentEvery: 'week',
        note: 'DUO, samen met Kim',
      });
    }, { timeout: 5000 });
    // weekly €120 ≈ €520/month on the overview (cadence-normalized)
    expect(screen.getByTestId('debts-overview').textContent).toMatch(/520/);
    db.close();
  }, 15_000);

  it('takes the comma a phone keypad offers as the decimal sign (#611)', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    fireEvent.click(await screen.findByTestId('debts-add'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Car loan' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '19000' } });
    typeOnAPhone(screen.getByTestId('chooser-acctform-apr'), '7,5');
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));

    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const account = (await db.accounts.toArray()).find((a) => a.name === 'Car loan');
      expect(account?.interestPctYear).toBe(7.5);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('detail projects the payoff; the account editor round-trips; delete leaves cleanly', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createLoan('Student loan', '10000', '12', '500');

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    expect(screen.getByTestId('debtdetail-remaining').textContent).toMatch(/10.000/);
    expect(screen.getByTestId('debtdetail-projection').textContent).toMatch(/interest/);

    fireEvent.click(screen.getByTestId('debtdetail-edit'));
    await waitFor(() => expect((screen.getByTestId('acctedit-name') as HTMLInputElement).value).toBe('Student loan'));
    expect((screen.getByTestId('acctedit-balance') as HTMLInputElement).value).toBe('10000.00');
    fireEvent.change(screen.getByTestId('acctedit-payment'), { target: { value: '1000' } });
    fireEvent.change(screen.getByTestId('acctedit-payday'), { target: { value: '28' } });
    fireEvent.click(screen.getByTestId('acctedit-save'));
    // await the write: the sheet lingers through its close animation
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const account = (await db.accounts.toArray()).find((a) => a.name === 'Student loan');
      expect(account?.paymentCents).toBe(100_000);
      expect(account?.paymentDay).toBe(28);
    }, { timeout: 5000 });
    db.close();
    // the live query re-emits after the write, so the text is awaited
    await waitFor(() => expect(document.body.textContent).toContain('Due day 28'), { timeout: 5000 });

    fireEvent.click(screen.getByTestId('debtdetail-edit'));
    fireEvent.click(await screen.findByTestId('acctedit-delete'));
    fireEvent.click(await screen.findByTestId('acctedit-remove-confirm'));
    await screen.findByTestId('debts-empty');
  }, 15_000);

  it("the recurring form's Debt kind asks fullscreen first, then hands off prefilled", async () => {
    renderApp('/recurring');
    await screen.findByTestId('screen-recurring');
    fireEvent.click(await screen.findByTestId('recurring-add'));
    fireEvent.change(await screen.findByTestId('recform-name'), { target: { value: 'Car loan' } });
    fireEvent.change(screen.getByTestId('recform-amount'), { target: { value: '250' } });
    fireEvent.click(screen.getByTestId('recform-kind-debt'));
    await screen.findByTestId('mina-debt-handoff');
    fireEvent.click(screen.getByTestId('mina-debt-handoff-stay'));
    await waitFor(() => expect(screen.queryByTestId('mina-debt-handoff')).toBeNull());
    expect((screen.getByTestId('recform-name') as HTMLInputElement).value).toBe('Car loan');

    fireEvent.click(screen.getByTestId('recform-kind-debt'));
    await screen.findByTestId('mina-debt-handoff');
    fireEvent.click(screen.getByTestId('mina-debt-handoff-continue'));
    // the recurring's amount and rhythm seed the loan's payment plan, never its original size
    await screen.findByTestId('screen-debts');
    fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
    await waitFor(() => expect((screen.getByTestId('chooser-acctform-name') as HTMLInputElement).value).toBe('Car loan'));
    expect((screen.getByTestId('chooser-acctform-payment') as HTMLInputElement).value).toBe('250.00');
  }, 15_000);

  it('the home block totals the debts; the settings row reaches debts', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await createLoan('Car loan', '5000', undefined, '250');

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
    // the #221 bare-row fold default-links bare rows: drain the boot chain before seeding so deliberately-bare rows stay bare
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');
    const accountId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    const base = { accountId: 'demo_main', currency: 'EUR', needsReview: 0 as const, txType: 'debtPayment' as const, catId: 'loanRepayment' };
    await repo.upsert('transaction', 'demo_space', 'bare1', { ...base, date: '2026-07-01', amountCents: -15_000, merchant: 'Aflossing' });
    await repo.upsert('transaction', 'demo_space', 'bare2', { ...base, date: '2026-07-15', amountCents: -15_000, merchant: 'Aflossing' });

    const unassigned = await screen.findByTestId('debts-unassigned');
    expect(unassigned.textContent).toContain('Unassigned');
    await waitFor(() => expect(screen.getByTestId('debts-unassigned').textContent).toMatch(/300/), { timeout: 5000 });
    fireEvent.click(unassigned);
    await screen.findByTestId('debts-unassigned-list');
    fireEvent.click(await screen.findByTestId('tx-row-bare1'));
    await screen.findByTestId('debts-assign-options');
    fireEvent.click(screen.getByTestId(`debts-assign-${accountId}`));

    await waitFor(async () => {
      expect((await db.transactions.get('bare1'))?.linkedAccountId).toBe(accountId);
    }, { timeout: 5000 });
    db.close();
  }, 15_000);

  it('empty payment fields estimate from ≥3 payments; the add-payment door pre-stages the loan', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createLoan('Car loan', '5000');
    const accountId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    const base = { accountId: 'demo_main', currency: 'EUR', needsReview: 0 as const, txType: 'debtPayment' as const, catId: 'loanRepayment', linkedAccountId: accountId };
    await repo.upsert('transaction', 'demo_space', 'pay1', { ...base, date: '2026-04-01', amountCents: -25_000, merchant: 'Termijn' });
    await repo.upsert('transaction', 'demo_space', 'pay2', { ...base, date: '2026-05-01', amountCents: -25_000, merchant: 'Termijn' });
    await repo.upsert('transaction', 'demo_space', 'pay3', { ...base, date: '2026-06-01', amountCents: -25_000, merchant: 'Termijn' });

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    const estimate = await screen.findByTestId('debtdetail-estimate');
    expect(estimate.textContent).toMatch(/250/);
    expect(estimate.textContent).toMatch(/estimated from payments/);
    expect(screen.getByTestId('debtdetail-projection')).toBeTruthy();

    fireEvent.click(screen.getByTestId('debtdetail-add-payment'));
    await screen.findByTestId('txform-save');
    await waitFor(() => expect(screen.getByTestId('txform-counter').textContent).toContain('Car loan'));
    expect((screen.getByTestId('txform-merchant') as HTMLInputElement).value).toBe('Car loan');
    db.close();
  }, 15_000);

  it('found-payments links history to the loan; pre-anchor rows count only on request', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    // drain the boot chain: its late bare-row fold could win the apply's link by LWW
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');
    const accountId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    // yesterday's payment predates the loan's balance date (typed today): linking must not move the number
    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    const y = new Date(Date.now() - 86_400_000);
    const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    await repo.upsert('transaction', 'demo_space', 'oldpay', {
      accountId: 'demo_main', date: yesterday, amountCents: -15_000, merchant: 'Aflossing',
      currency: 'EUR', needsReview: 0, catId: 'loanRepayment',
    });

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-oldpay');
    // the strong-match pre-check settles an effect tick after the row
    await waitFor(() => expect((screen.getByTestId('loanmatch-pick-oldpay') as HTMLInputElement).checked).toBe(true));
    expect(screen.getByTestId('loanmatch-old-caption').textContent).toContain('Deducts');
    expect(screen.getByTestId('loanmatch-count-oldpay').getAttribute('aria-checked')).toBe('false');
    fireEvent.click(screen.getByTestId('loanmatch-apply'));

    await waitFor(async () => {
      expect((await db.transactions.get('oldpay'))?.linkedAccountId).toBe(accountId);
    }, { timeout: 5000 });
    // linked but NOT counted: the typed balance already contained it
    expect((await db.accounts.get(accountId))?.balanceCents).toBe(-500_000);

    cleanup();
    renderApp('/transactions/oldpay');
    fireEvent.click(await screen.findByTestId('tx-detail-loan-count', {}, { timeout: 5000 }));
    await waitFor(async () => {
      expect((await db.accounts.get(accountId))?.balanceCents).toBe(-485_000);
    }, { timeout: 5000 });
    expect((await db.transactions.get('oldpay'))?.loanCounted).toBe(1);
    db.close();
  }, 20_000);

  it('#286 r3: flipping the trailing Deducts switch subtracts a pre-anchor payment at apply', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    // drain the boot chain: its late bare-row fold could win the apply's link by LWW
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');
    const accountId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    const y = new Date(Date.now() - 86_400_000);
    const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
    await repo.upsert('transaction', 'demo_space', 'oldpay2', {
      accountId: 'demo_main', date: yesterday, amountCents: -15_000, merchant: 'Aflossing',
      currency: 'EUR', needsReview: 0, catId: 'loanRepayment',
    });

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-oldpay2');
    await waitFor(() => expect((screen.getByTestId('loanmatch-pick-oldpay2') as HTMLInputElement).checked).toBe(true));
    fireEvent.click(screen.getByTestId('loanmatch-count-oldpay2'));
    expect(screen.getByTestId('loanmatch-count-oldpay2').getAttribute('aria-checked')).toBe('true');
    fireEvent.click(screen.getByTestId('loanmatch-apply'));

    await waitFor(async () => {
      expect((await db.transactions.get('oldpay2'))?.loanCounted).toBe(1);
      // counted: the pre-anchor payment lowers the loan (−5000 → −4850)
      expect((await db.accounts.get(accountId))?.balanceCents).toBe(-485_000);
    }, { timeout: 5000 });
    db.close();
  }, 20_000);

  it('a paid-off loan archives from the detail; a card stops tracking instead', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createLoan('Car loan', '5000');
    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');

    fireEvent.click(screen.getByTestId('debtdetail-archive'));
    await waitFor(() => expect(screen.getByTestId('debtdetail-archive').textContent).toContain('Reopen'));
    cleanup();
    renderApp('/debts');
    const archived = await waitFor(() => {
      const el = document.querySelector('[data-testid^="debt-card-"]');
      expect(el).toBeTruthy();
      return el!;
    }, { timeout: 5000 });
    expect(archived.className).toContain('opacity-60');
  }, 15_000);

  it('#286 r2: a loan created WITH matching history still auto-offers the sheet', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    // drain the boot chain before seeding: its late bare-row fold would link the seed
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    await repo.upsert('transaction', 'demo_space', 'prepay', {
      accountId: 'demo_main', date: '2026-08-01', amountCents: -15_000, merchant: 'Aflossing',
      currency: 'EUR', needsReview: 0, catId: 'loanRepayment',
    });
    // the live queries must have folded the row in before the create begins
    await screen.findByTestId('debts-unassigned');

    fireEvent.click(screen.getByTestId('debts-add'));
    fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
    fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Car loan' } });
    fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '5000' } });
    fireEvent.click(screen.getByTestId('chooser-acctform-save'));

    // awaited: a floating find leaked a rejection into later specs
    expect(await screen.findByTestId('loanmatch-pick-prepay')).toBeTruthy();
    db.close();
  }, 15_000);

  it('#286 r2: manual Find payments with nothing to link shows one quiet line only', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    const card = await createLoan('Car loan', '5000');
    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    const empty = await screen.findByTestId('loanmatch-empty');
    expect(empty.textContent).toBe('No transactions found to link.');
    expect(screen.queryByTestId('loanmatch-hint')).toBeNull();
    expect(screen.queryByTestId('loanmatch-apply')).toBeNull();
  }, 15_000);

  it('#286 r3: the pinned footer sums deducting picks; the row face toggles the pick', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    // drain the boot chain before seeding: its late bare-row fold would link the seed
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    await seedPayment(repo, 'sum1', isoDayOffset(-1));

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-sum1');
    await waitFor(() => expect((screen.getByTestId('loanmatch-pick-sum1') as HTMLInputElement).checked).toBe(true));

    expect(screen.getByTestId('loanmatch-summary').textContent).toContain('1 selected');
    expect(screen.getByTestId('loanmatch-deduct-sum').textContent).toMatch(/0\.00/);
    expect(screen.getByTestId('loanmatch-new-balance').textContent).toMatch(/5.000\.00.*→.*5.000\.00/);

    fireEvent.click(screen.getByTestId('loanmatch-count-sum1'));
    expect(screen.getByTestId('loanmatch-deduct-sum').textContent).toMatch(/150\.00/);
    expect(screen.getByTestId('loanmatch-new-balance').textContent).toMatch(/4.850\.00/);

    fireEvent.click(screen.getByTestId('tx-row-sum1'));
    expect((screen.getByTestId('loanmatch-pick-sum1') as HTMLInputElement).checked).toBe(false);
    expect(screen.getByTestId('loanmatch-summary').textContent).toContain('0 selected');
    expect(screen.getByTestId('loanmatch-deduct-sum').textContent).toMatch(/0\.00/);
    fireEvent.click(screen.getByTestId('tx-row-sum1'));
    expect((screen.getByTestId('loanmatch-pick-sum1') as HTMLInputElement).checked).toBe(true);
    db.close();
  }, 20_000);

  it('#286 r3: original == current balance auto-deducts every candidate; apply moves the number', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    // the loan still stands at its full size, so found payments must deduct
    const card = await createLoan('Car loan', '5000', undefined, undefined, '5000');
    const accountId = card.getAttribute('data-testid')!.replace('debt-card-', '');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    await seedPayment(repo, 'auto1', isoDayOffset(-1));

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-auto1');
    await waitFor(() => expect(screen.getByTestId('loanmatch-count-auto1').getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByTestId('loanmatch-new-balance').textContent).toMatch(/4.850\.00/);

    fireEvent.click(screen.getByTestId('loanmatch-apply'));
    await waitFor(async () => {
      expect((await db.transactions.get('auto1'))?.linkedAccountId).toBe(accountId);
      expect((await db.accounts.get(accountId))?.balanceCents).toBe(-485_000);
    }, { timeout: 5000 });
    // #509: a loan typed at its original amount carries no balance date — every payment counts by itself
    expect((await db.accounts.get(accountId))?.balanceAsOf ?? undefined).toBeUndefined();
    db.close();
  }, 20_000);

  it('#286 r3: select-all and deduct-all sweep both columns', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    await seedPayment(repo, 'bulk1', isoDayOffset(-1));
    await seedPayment(repo, 'bulk2', isoDayOffset(-2));

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-bulk2');
    await waitFor(() => expect((screen.getByTestId('loanmatch-pick-bulk1') as HTMLInputElement).checked).toBe(true));

    const pickAll = screen.getByTestId('loanmatch-pick-all');
    expect(pickAll.dataset.state).toBe('all');
    fireEvent.click(pickAll);
    expect(screen.getByTestId('loanmatch-summary').textContent).toContain('0 selected');
    expect((screen.getByTestId('loanmatch-pick-bulk1') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(pickAll);
    expect(screen.getByTestId('loanmatch-summary').textContent).toContain('2 selected');

    fireEvent.click(screen.getByTestId('loanmatch-deduct-all'));
    expect(screen.getByTestId('loanmatch-count-bulk1').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('loanmatch-count-bulk2').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('loanmatch-deduct-sum').textContent).toMatch(/300\.00/);
    fireEvent.click(screen.getByTestId('loanmatch-deduct-all'));
    expect(screen.getByTestId('loanmatch-count-bulk1').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('loanmatch-deduct-sum').textContent).toMatch(/0\.00/);
    db.close();
  }, 20_000);

  it('#286 r3: a post-anchor row wears a disabled always-on deduct switch', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    await seedPayment(repo, 'newpay', isoDayOffset(1));

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-newpay');
    await waitFor(() => expect((screen.getByTestId('loanmatch-pick-newpay') as HTMLInputElement).checked).toBe(true));

    const sw = screen.getByTestId('loanmatch-count-newpay');
    expect(sw.getAttribute('aria-disabled')).toBe('true');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(sw);
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('loanmatch-old-caption')).toBeNull();
    expect(screen.getByTestId('loanmatch-deduct-all').getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByTestId('loanmatch-new-balance').textContent).toMatch(/4.850\.00/);
    db.close();
  }, 20_000);

  it('#286 r3: dismissing with candidates asks first; discard closes without linking', async () => {
    renderApp('/debts');
    await screen.findByTestId('screen-debts');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const card = await createLoan('Car loan', '5000');

    const db = new MunniDB('munni_demo');
    const repo = demoRepo(db);
    await seedPayment(repo, 'guard1', isoDayOffset(-1));

    fireEvent.click(card);
    await screen.findByTestId('debtdetail-hero');
    fireEvent.click(screen.getByTestId('debtdetail-find-payments'));
    await screen.findByTestId('loanmatch-pick-guard1');
    await waitFor(() => expect((screen.getByTestId('loanmatch-pick-guard1') as HTMLInputElement).checked).toBe(true));

    fireEvent.keyDown(window, { key: 'Escape' });
    await screen.findByTestId('sheet-discard');
    fireEvent.click(screen.getByTestId('sheet-keep-editing'));
    expect((screen.getByTestId('loanmatch-pick-guard1') as HTMLInputElement).checked).toBe(true);

    // test-mode sheets stay mounted: the emptied candidate list is the observable, not the sheet's absence
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('sheet-discard'));
    await waitFor(() => expect(screen.queryByTestId('loanmatch-pick-guard1')).toBeNull());
    expect((await db.transactions.get('guard1'))?.linkedAccountId).toBeUndefined();
    expect((await db.accounts.toArray()).find((a) => a.name === 'Car loan')?.balanceCents).toBe(-500_000);
    db.close();
  }, 20_000);
});
