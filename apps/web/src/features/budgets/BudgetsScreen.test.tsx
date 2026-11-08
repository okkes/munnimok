// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID, isoDaysAgo } from '@/db/seed';
import { HlcClock } from '@/sync/hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';

async function createBudget(name: string, amount: string, catTestId = 'budget-cat-groceries') {
  fireEvent.click(await screen.findByTestId('budgets-add'));
  await screen.findByTestId('screen-budget-form');
  fireEvent.change(screen.getByTestId('budgetform-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('budgetform-amount'), { target: { value: amount } });
  // anchored in the past so the detail's period nav has cycles to walk
  const past = new Date();
  past.setMonth(past.getMonth() - 3, 1);
  fireEvent.change(screen.getByTestId('budgetform-anchor'), {
    target: { value: `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, '0')}-01` },
  });
  // mains start collapsed now (user request) — unfold before picking
  fireEvent.click(await screen.findByTestId('budgetform-fold-consumption'));
  fireEvent.click(await screen.findByTestId(catTestId));
  fireEvent.click(screen.getByTestId('budgetform-save'));
  await screen.findByTestId('screen-budgets');
}

describe('Budgets (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('creates a budget; the list card shows urgency-colored numbers', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    await screen.findByTestId('budgets-empty');

    await createBudget('Food', '500');
    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="budget-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(card.textContent).toContain('Food');
    // the demo seed has groceries spending this month → spent shows money
    await waitFor(() => expect(card.textContent).toMatch(/€[1-9]/));
    expect(card.textContent).toMatch(/left|over/);
  }, 15_000);

  it('a category claimed by one budget is disabled with a badge in the next', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    await createBudget('Food', '500');

    fireEvent.click(screen.getByTestId('budgets-add'));
    await screen.findByTestId('screen-budget-form');
    fireEvent.click(await screen.findByTestId('budgetform-fold-consumption'));
    const conflict = await screen.findByTestId('budget-cat-conflict-groceries');
    expect(conflict.textContent).toContain('Food');
    expect((screen.getByTestId('budget-cat-groceries') as HTMLInputElement).disabled).toBe(true);
    // #374: the main stays pickable — it takes every sub that is still free, and with
    // groceries held by Food it is only partly this budget's: indeterminate, never a full tick
    const main = screen.getByTestId('budget-cat-consumption') as HTMLInputElement;
    expect(main.disabled).toBe(false);
    fireEvent.click(main);
    expect(main.dataset.state).toBe('half');
    expect([main.checked, main.indeterminate]).toEqual([false, true]);
    expect((screen.getByTestId('budget-cat-groceries') as HTMLInputElement).disabled).toBe(true);
    const coffee = screen.getByTestId('budget-cat-coffee') as HTMLInputElement;
    expect(coffee.dataset.state).toBe('checked');
    fireEvent.click(coffee);
    expect(coffee.dataset.state).toBe('off');
    expect(main.dataset.state).toBe('half');
    // the half main's tap picks every free sub again; the next one lets them all go
    fireEvent.click(main);
    expect(coffee.dataset.state).toBe('checked');
    fireEvent.click(main);
    expect(main.dataset.state).toBe('off');
    expect([main.checked, main.indeterminate]).toEqual([false, false]);
    // Enter ticks a row too, as it did while the row was a button
    fireEvent.keyDown(coffee, { key: 'Enter' });
    expect(coffee.dataset.state).toBe('checked');
  }, 15_000);

  it('#375: a tap on a history bar walks the period nav to that cycle; #371/#372: the form names the start date, a reset day and plain rollover words', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    await createBudget('Food', '500');
    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="budget-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(card);
    await screen.findByTestId('budgetdetail-hero');
    const label = screen.getByTestId('budgetdetail-period').textContent;
    // #375 r2: the dashed line says what it is — the budget per period
    expect((await screen.findByTestId('budgetdetail-bars-average-label')).textContent).toMatch(/Budget €500\.00/);
    expect(screen.getByTestId('budgetdetail-limit-legend').textContent).toMatch(/dashed line is your budget per period/);
    fireEvent.click(await screen.findByTestId('budgetdetail-bars-bar-0'));
    await waitFor(() => expect(screen.getByTestId('budgetdetail-period').textContent).not.toBe(label));
    fireEvent.click(screen.getByTestId('budgetdetail-edit'));
    await screen.findByTestId('screen-budget-form');
    // the row loads async — type only once the form holds it, or the load overwrites the draft
    await waitFor(() => expect((screen.getByTestId('budgetform-name') as HTMLInputElement).value).toBe('Food'));
    expect(screen.getByText('Start date')).toBeTruthy();
    fireEvent.change(screen.getByTestId('budgetform-resetday'), { target: { value: '31' } });
    fireEvent.blur(screen.getByTestId('budgetform-resetday'));
    expect((screen.getByTestId('budgetform-resetday') as HTMLInputElement).value).toBe('28');
    fireEvent.click(screen.getByTestId('budgetform-carry'));
    expect((await screen.findByTestId('budgetform-carry-explain')).textContent).toContain('1 period');
  }, 20_000);

  it('detail shows the cycle numbers, per-category rows, and past periods', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    await createBudget('Food', '500');

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="budget-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(card);
    await screen.findByTestId('budgetdetail-hero');
    await waitFor(() => expect(screen.getByTestId('budgetdetail-spent').textContent).toMatch(/€/));
    // the current cycle announces its remaining days (user request)
    expect(screen.getByTestId('budgetdetail-daysleft').textContent).toMatch(/\d+/);

    // category rows are FILTERS now (user request): tapping narrows the
    // payments list and tapping again clears
    const catRow = screen.getByTestId('budgetdetail-cat-groceries');
    fireEvent.click(catRow);
    await waitFor(() => expect(catRow.className).toContain('bg-accent-soft'));
    fireEvent.click(catRow);
    await waitFor(() => expect(catRow.className).not.toContain('bg-accent-soft'));

    // period nav walks backwards and returns
    const label = screen.getByTestId('budgetdetail-period').textContent;
    fireEvent.click(screen.getByTestId('budgetdetail-prev'));
    await waitFor(() => expect(screen.getByTestId('budgetdetail-period').textContent).not.toBe(label));
    fireEvent.click(screen.getByTestId('budgetdetail-next'));
    await waitFor(() => expect(screen.getByTestId('budgetdetail-period').textContent).toBe(label));

    // edit opens prefilled; delete needs a second tap and lands on the list
    fireEvent.click(screen.getByTestId('budgetdetail-edit'));
    await screen.findByTestId('screen-budget-form');
    await waitFor(() => expect((screen.getByTestId('budgetform-name') as HTMLInputElement).value).toBe('Food'));
    fireEvent.click(await screen.findByTestId('budgetform-delete'));
    fireEvent.click(screen.getByTestId('budgetform-delete'));
    await screen.findByTestId('screen-budgets');
    await waitFor(() => expect(document.querySelector('[data-testid^="budget-card-"]')).toBeNull());
  }, 15_000);

  it('#579: the part of a split that the budget counts is listed among its payments, opening the part', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-579'), { trackOutbox: false });
    const today = isoDaysAgo(0);
    await repo.upsert('budget', DEMO_SPACE_ID, 'b579', {
      name: 'Dating', amountCents: 20_000, every: 'month', anchor: `${today.slice(0, 8)}01`, catIds: ['groceries'], active: 1,
    });
    // the row's own (largest) category is transport — only its €30 part is the budget's
    await repo.upsert('transaction', DEMO_SPACE_ID, 'split579', {
      accountId: 'demo_main', date: today, amountCents: -8000, currency: 'EUR', merchant: 'Dinner and taxi',
      catId: 'transport', needsReview: 0,
      splits: [
        { id: 'p579a', catId: 'transport', amountCents: 5000 },
        { id: 'p579b', catId: 'groceries', amountCents: 3000 },
      ],
    });
    db.close();
    renderApp('/budgets/b579');
    const list = await screen.findByTestId('budgetdetail-txs', {}, { timeout: 5000 });
    const part = await waitFor(() => {
      const el = list.querySelector('[data-testid="tx-part-solo-split579-1"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(part.textContent).toContain('30.00');
    // the transport part is not the budget's business
    expect(list.querySelector('[data-testid="tx-part-solo-split579-0"]')).toBeNull();
    fireEvent.click(part);
    await screen.findByTestId('screen-tx-detail');
  }, 15_000);

  it('the home block surfaces the budget and leads back to the list', async () => {
    renderApp('/budgets');
    await screen.findByTestId('screen-budgets');
    await createBudget('Food', '500');

    renderApp('/home');
    const block = await screen.findByTestId('home-budgets', {}, { timeout: 5000 });
    expect(block.textContent).toContain('Food');
    fireEvent.click(screen.getByTestId('home-budgets-all'));
    expect(await screen.findByTestId('screen-budgets')).toBeTruthy();
  }, 15_000);

  it('carry-over config saves and the settings row reaches the screen', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-budgets-row'));
    await screen.findByTestId('screen-budgets');

    fireEvent.click(screen.getByTestId('budgets-add'));
    await screen.findByTestId('screen-budget-form');
    fireEvent.change(screen.getByTestId('budgetform-name'), { target: { value: 'Fun' } });
    fireEvent.change(screen.getByTestId('budgetform-amount'), { target: { value: '50' } });
    fireEvent.click(screen.getByTestId('budgetform-every-week'));
    fireEvent.click(await screen.findByTestId('budget-cat-entertainment'));
    fireEvent.click(screen.getByTestId('budgetform-carry'));
    fireEvent.click(await screen.findByTestId('budgetform-carrymode-cap'));
    fireEvent.change(screen.getByTestId('budgetform-carrycap'), { target: { value: '150' } });
    // #534: the demo has no account to be warned through — the threshold rests
    expect((screen.getByTestId('budgetform-notify-90') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('budgetform-save'));
    await screen.findByTestId('screen-budgets');

    // reopen: the configuration round-trips
    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="budget-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('budgetdetail-edit'));
    await screen.findByTestId('screen-budget-form');
    await waitFor(() => expect((screen.getByTestId('budgetform-name') as HTMLInputElement).value).toBe('Fun'));
    expect((screen.getByTestId('budgetform-carrycap') as HTMLInputElement).value).toBe('150.00');
  }, 15_000);
});
