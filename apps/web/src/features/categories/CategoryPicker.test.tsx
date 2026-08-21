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

describe('CategoryPicker direction filtering (via add-transaction form)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('an expense hides credit-only categories', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    // the account field replaced the chips (2026-07-31): the CategoryPicker
    // direction only needs AN account — pick the main one through the sheet
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));

    // expense (debit): the custom Padel main's Other sub (direction both)
    // is offered once the catalog's live query delivers the custom rows…
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');
    await screen.findByTestId('catpicker-demo_cat_padel_other');
    // …while the demo credit-only sub "Side gig" is hidden
    expect(screen.queryByTestId('catpicker-demo_cat_sidegig')).toBeNull();
  }, 15_000);

  it('income shows credit-only categories and hides debit-only ones', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    // the account field replaced the chips (2026-07-31): the CategoryPicker
    // direction only needs AN account — pick the main one through the sheet
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    // toggle BEFORE opening the editor: a fresh stack per direction
    fireEvent.click(screen.getByTestId('txform-income'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-demo_cat_sidegig');
    // movement subs went direction-both in typed-splits v2 (they live on
    // either leg now) — groceries is the debit-only witness instead
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
    // debit picker without a type gate offers the saving family — marked
    await screen.findByTestId('speccat-savingDeposit');
    await screen.findByTestId('catpicker-groceries');
    expect(screen.queryByTestId('speccat-groceries')).toBeNull();
  }, 15_000);

  it('a dead-end search offers creating a custom category (user request)', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    // the account field replaced the chips (2026-07-31): the CategoryPicker
    // direction only needs AN account — pick the main one through the sheet
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    // the create door is always at the list's end…
    expect(screen.getByTestId('catpicker-create-custom')).toBeTruthy();
    // …and a no-result search says so explicitly
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'zzz-no-such-cat' } });
    expect(await screen.findByTestId('catpicker-empty')).toBeTruthy();
    fireEvent.click(screen.getByTestId('catpicker-create-custom'));
    expect(await screen.findByTestId('screen-manage-cats')).toBeTruthy();
  }, 15_000);

  it('tobacco and alcohol are separate consumption categories', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    // the account field replaced the chips (2026-07-31): the CategoryPicker
    // direction only needs AN account — pick the main one through the sheet
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
    await screen.findByTestId('catpicker-groceries');

    // "padel" matches only the custom PARENT — its Other sub must survive
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'padel' } });
    await screen.findByTestId('catpicker-demo_cat_padel_other');
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();

    // #187: the highlighted fragment stays inside one inline run — the
    // <mark> must not sit as a direct child of the gapped flex row
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'ocer' } });
    const row = await screen.findByTestId('catpicker-groceries');
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
    // the brokerage ledger speaks investment: Bought is offered…
    await screen.findByTestId('catpicker-investBuy');
    // …while everyday expense categories and Adjustment stay out
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();
    expect(screen.queryByTestId('catpicker-balanceAdjustment')).toBeNull();
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

  it('#245/#246: the ◆ chip narrows to specials; the search rides the scroll', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    // the ◆ lens: plain categories out, marked rows stay
    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await waitFor(() => expect(screen.queryByTestId('catpicker-groceries')).toBeNull());
    expect(document.querySelector('[data-testid^="speccat-"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await screen.findByTestId('catpicker-groceries');

    // #245: browsing DOWN slips the search away; deliberate upward
    // travel (one field's worth) brings it back. #273: the wrapper is
    // the shared gliding collapse now (max-height + opacity together)
    const list = screen.getByTestId('catpicker-list');
    Object.defineProperty(list, 'scrollHeight', { value: 1400, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    const wrapper = screen.getByTestId('catpicker-search-wrap') as HTMLElement;
    list.scrollTop = 400;
    fireEvent.scroll(list);
    await waitFor(() => expect(wrapper.style.pointerEvents).toBe('none'));
    expect(wrapper.style.maxHeight).toMatch(/^0/);
    list.scrollTop = 370;
    fireEvent.scroll(list);
    list.scrollTop = 320;
    fireEvent.scroll(list);
    await waitFor(() => expect(wrapper.style.pointerEvents).toBe(''));
    expect(wrapper.style.maxHeight).not.toMatch(/^0(px)?$/);
  }, 15_000);
});
