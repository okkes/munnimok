// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { visibleTransactions } from '@/db/joined';

describe('CategoryPicker direction filtering (via add-transaction form)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('income shows credit-only categories and hides debit-only ones', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    // toggle BEFORE opening the editor: a fresh stack per direction
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-demo_cat_sidegig');
    // groceries is the debit-only witness: movement subs are direction-both
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();
  }, 15_000);

  it('special categories wear the diamond mark, ordinary ones do not (user 2026-08-05)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('speccat-savingDeposit');
    await screen.findByTestId('catpicker-groceries');
    expect(screen.queryByTestId('speccat-groceries')).toBeNull();
  }, 15_000);

  it('a dead-end search offers creating a custom category (user request)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    expect(screen.getByTestId('catpicker-create-custom')).toBeTruthy();
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'zzz-no-such-cat' } });
    expect(await screen.findByTestId('catpicker-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('catpicker-create-custom'));
    expect(await screen.findByTestId('screen-manage-cats')).toBeTruthy();
  }, 15_000);

  it('tobacco and alcohol are separate consumption categories', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-alcohol');
    expect(screen.getByTestId('catpicker-tobacco')).toBeTruthy();
    // the expected-reimbursement expense left its hidden parent and is pickable
    expect(screen.getByTestId('catpicker-expenseReimburse')).toBeTruthy();
  });

  it('#214: a query hitting a PARENT name keeps the whole group; #187: the match never splits the word', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-breakfast');

    // "padel" matches only the custom PARENT — its Other sub must survive
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'padel' } });
    await screen.findByTestId('catpicker-demo_cat_padel_other');
    expect(screen.queryByTestId('catpicker-breakfast')).toBeNull();

    // #187: the <mark> must not sit as a direct child of the gapped flex row
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'reakfas' } });
    const row = await screen.findByTestId('catpicker-breakfast');
    const mark = row.querySelector('mark');
    expect(mark).toBeTruthy();
    expect(mark!.parentElement!.className).not.toContain('gap-');
  }, 15_000);

  it('#256: a brokerage account’s manual form offers only the investment story', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-256'), { trackOutbox: false });
    await repo.upsert('account', DEMO_SPACE_ID, 'brok_256', {
      name: 'DEGIRO manual',
      type: 'brokerage',
      source: 'manual',
      balanceCents: 0,
      currency: 'EUR',
    });
    db.close();

    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-brok_256'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-investBuy');
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();
    expect(screen.queryByTestId('catpicker-balanceAdjustment')).toBeNull();
  }, 15_000);

  it('#664: money coming into a savings account may be filed as income; money leaving it may not', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-664'), { trackOutbox: false });
    await repo.upsert('account', DEMO_SPACE_ID, 'pot_664', { name: 'Piggy manual', type: 'savings', source: 'manual', balanceCents: 0, currency: 'EUR' });
    db.close();

    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-pot_664'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    // money out of the pot: its own family alone
    await screen.findByTestId('catpicker-savingWithdraw');
    expect(screen.queryByTestId('catpicker-giftReceived')).toBeNull();
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();
  }, 15_000);

  it('#664: the income side of a savings account offers the Income family next to its own', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-664b'), { trackOutbox: false });
    await repo.upsert('account', DEMO_SPACE_ID, 'pot_664', { name: 'Piggy manual', type: 'savings', source: 'manual', balanceCents: 0, currency: 'EUR' });
    db.close();

    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-pot_664'));
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-giftReceived');
    expect(screen.getByTestId('catpicker-savingInterest')).toBeTruthy();
    expect(screen.getByTestId('catpicker-savingDeposit')).toBeTruthy();
    // the person's own income sub rides along; spending stays out
    expect(screen.getByTestId('catpicker-demo_cat_sidegig')).toBeTruthy();
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();
    expect(screen.queryByTestId('catpicker-savingWithdraw')).toBeNull();

    // filed and saved, the row keeps the income category and counts as income
    fireEvent.click(screen.getByTestId('catpicker-giftReceived'));
    fireEvent.click(await screen.findByTestId('part-cat-save'));
    fireEvent.change(screen.getByTestId('txform-amount'), { target: { value: '25,00' } });
    fireEvent.change(screen.getByTestId('txform-merchant'), { target: { value: 'Bank bonus' } });
    fireEvent.click(screen.getByTestId('txform-save'));
    const store = new DexieBackend(new MunniDB('munni_demo'));
    await waitFor(async () => {
      const saved = (await visibleTransactions(store, DEMO_SPACE_ID)).find((t) => t.accountId === 'pot_664');
      expect(saved).toMatchObject({ catId: 'giftReceived', amountCents: 2500, txType: 'income' });
      expect(saved?.linkedAccountId).toBeUndefined();
    });
  }, 15_000);

  it('#261: Adjustment never rides the standard-row escape into an expense picker', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');
    // the ◆ transfer-family escape stays (Set aside is pickable)…
    expect(screen.getByTestId('catpicker-savingDeposit')).toBeTruthy();
    // …but the locked Adjustment family does not tag along
    expect(screen.queryByTestId('catpicker-balanceAdjustment')).toBeNull();
  }, 15_000);

  it('the ◆ lens narrows the picker to special categories and toggles back', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await waitFor(() => expect(screen.queryByTestId('catpicker-groceries')).toBeNull());
    expect(document.querySelector('[data-testid^="speccat-"]')).toBeTruthy();
    expect(screen.getByTestId('catpicker-special-filter').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await screen.findByTestId('catpicker-groceries');
  }, 15_000);

  it('the picker is full height, with the search and its lenses pinned at the top while the list scrolls (user 2026-10-06)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    const wrap = screen.getByTestId('catpicker-search-wrap');
    expect(wrap.className).toContain('sticky');
    expect(wrap.contains(screen.getByTestId('catpicker-search'))).toBe(true);
    expect(wrap.contains(screen.getByTestId('catpicker-special-filter'))).toBe(true);
    expect(wrap.closest('[data-full]')).toBeTruthy();
    // no inner scroller caps the list any more — the sheet's own scrolls
    expect((screen.getByTestId('catpicker-list') as HTMLElement).style.maxHeight).toBe('');
  }, 15_000);

  it('lens and query reset when the picker closes — the next visit starts whole', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await waitFor(() => expect(screen.queryByTestId('catpicker-groceries')).toBeNull());
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'gro' } });
    // dismiss WITHOUT picking (Escape reaches only the top sheet)…
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');
    expect(screen.getByTestId('catpicker-special-filter').getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByTestId('catpicker-search') as HTMLInputElement).value).toBe('');
  }, 15_000);

  it('#322: a counter-narrowed picker offers the detach door — tap frees the full catalog in place', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    // a ◆ family pick asks its counterparty; the savings pot answers
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    fireEvent.click(await screen.findByTestId('counter-pick-demo_save'));
    await waitFor(() => expect(screen.getByTestId('part-cats-editor').getAttribute('data-counter')).toBe('demo_save'));

    fireEvent.click(screen.getByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-clear-counter');
    expect(screen.getByTestId('catpicker-savingDeposit')).toBeTruthy();
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();

    fireEvent.click(screen.getByTestId('catpicker-clear-counter'));
    await screen.findByTestId('catpicker-groceries');
    expect(screen.getByTestId('part-cats-editor').getAttribute('data-counter')).toBe('');
    expect(screen.queryByTestId('catpicker-clear-counter')).toBeNull();
  }, 15_000);

});
