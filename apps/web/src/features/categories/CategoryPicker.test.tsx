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

  it('the ◆ lens narrows the picker to special categories and toggles back', async () => {
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
    expect(screen.getByTestId('catpicker-special-filter').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await screen.findByTestId('catpicker-groceries');
  }, 15_000);

  it('the search field rides the scroll 1:1, comes back whole on a filter change, and never overshoots a short list', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');

    const list = screen.getByTestId('catpicker-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { value: 1400, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    const wrapper = screen.getByTestId('catpicker-search-wrap') as HTMLElement;
    const shown = () => Number.parseFloat(wrapper.style.height);
    const listCap = () => Number.parseFloat(list.style.maxHeight);
    const whole = shown();
    const capAtRest = listCap();

    // 30px of downward travel tucks exactly 30px of the field away — and
    // the list's cap grows by the same amount, so the tail stays reachable
    list.scrollTop = 30;
    fireEvent.scroll(list);
    await waitFor(() => expect(shown()).toBe(whole - 30));
    expect(listCap()).toBe(capAtRest + 30);
    expect(wrapper.style.pointerEvents).toBe('');
    // far enough down the field settles on its collapsed floor, still tappable
    list.scrollTop = 400;
    fireEvent.scroll(list);
    await waitFor(() => expect(shown()).toBeLessThan(whole - 30));
    const floor = shown();
    expect(floor).toBeGreaterThan(0);
    // upward travel reveals it the same 1:1 way
    list.scrollTop = 340;
    fireEvent.scroll(list);
    await waitFor(() => expect(shown()).toBe(floor + 60));

    // a query change shrinks the content: the field returns whole and the
    // list rewinds to its top instead of rubber-banding on stale slack
    list.scrollTop = 400;
    fireEvent.scroll(list);
    await waitFor(() => expect(shown()).toBe(floor));
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'groc' } });
    await waitFor(() => expect(shown()).toBe(whole));
    expect(listCap()).toBe(capAtRest);
    expect(list.scrollTop).toBe(0);

    // a SHORT list only spends the scroll room still below it: 150 of a
    // 200px range leaves 50px, so at most 50px of the field tucks away
    Object.defineProperty(list, 'scrollHeight', { value: 600, configurable: true });
    list.scrollTop = 150;
    fireEvent.scroll(list);
    await waitFor(() => expect(shown()).toBe(whole - 50));
  }, 15_000);

  it('lens, query and the tucked-away field all reset when the picker closes — the next visit starts whole', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');
    const shown = () => Number.parseFloat((screen.getByTestId('catpicker-search-wrap') as HTMLElement).style.height);
    const whole = shown();

    fireEvent.click(screen.getByTestId('catpicker-special-filter'));
    await waitFor(() => expect(screen.queryByTestId('catpicker-groceries')).toBeNull());
    // a typed query must not survive the close either…
    fireEvent.change(screen.getByTestId('catpicker-search'), { target: { value: 'gro' } });
    // …nor a field scrolled partly out of sight
    const list = screen.getByTestId('catpicker-list') as HTMLElement;
    Object.defineProperty(list, 'scrollHeight', { value: 1400, configurable: true });
    Object.defineProperty(list, 'clientHeight', { value: 400, configurable: true });
    list.scrollTop = 40;
    fireEvent.scroll(list);
    await waitFor(() => expect(shown()).toBeLessThan(whole));
    // dismiss WITHOUT picking (Escape reaches only the top sheet)…
    fireEvent.keyDown(window, { key: 'Escape' });
    // …and the reopened picker starts whole: chip off, field empty and
    // fully shown, full catalog back
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-groceries');
    expect(screen.getByTestId('catpicker-special-filter').getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByTestId('catpicker-search') as HTMLInputElement).value).toBe('');
    await waitFor(() => expect(shown()).toBe(whole));
  }, 15_000);

  it('#322: a counter-narrowed picker offers the detach door — tap frees the full catalog in place', async () => {
    renderApp('/transactions');
    await screen.findByTestId('tx-list');
    fireEvent.click(screen.getByTestId('tx-add'));
    fireEvent.click(await screen.findByTestId('txform-account'));
    fireEvent.click(await screen.findByTestId('txform-account-demo_main'));
    fireEvent.click(screen.getByTestId('txform-category'));
    fireEvent.click(await screen.findByTestId('part-cat-0'));
    // a ◆ family pick asks its counterparty; the pinned Default answers
    fireEvent.click(await screen.findByTestId('catpicker-savingDeposit'));
    fireEvent.click(await screen.findByTestId('counter-default'));
    await waitFor(() => expect(screen.getByTestId('part-cats-editor').getAttribute('data-counter')).not.toBe(''));

    // the standing counter narrows the reopened picker to what it can
    // mean — and the door says why, right where the narrowing bites
    fireEvent.click(screen.getByTestId('part-cat-0'));
    await screen.findByTestId('catpicker-clear-counter');
    expect(screen.getByTestId('catpicker-savingDeposit')).toBeTruthy();
    expect(screen.queryByTestId('catpicker-groceries')).toBeNull();

    // the door runs the counter row's own detach: link gone, category
    // reset, and the picker un-narrows without closing
    fireEvent.click(screen.getByTestId('catpicker-clear-counter'));
    await screen.findByTestId('catpicker-groceries');
    expect(screen.getByTestId('part-cats-editor').getAttribute('data-counter')).toBe('');
    expect(screen.queryByTestId('catpicker-clear-counter')).toBeNull();
  }, 15_000);

});
