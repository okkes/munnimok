// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { DEMO_SPACE_ID } from '@/db/seed';
import { cashWalletId } from '@/domain/defaultAccounts';
import { MunniDB } from '@/db/schema';
import { HlcClock } from '@/sync/hlc';
import { compactMoney, recallGraphView, rememberGraphView, truncateLabel } from './format';

/** the demo space row as the store holds it right now */
async function readSpace() {
  const db = new MunniDB('munni_demo');
  try {
    return await db.spaces.get(DEMO_SPACE_ID);
  } finally {
    db.close();
  }
}

describe('TrendsScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('settings reaches trends; the built-in card charts the periods with numbers, the picker narrows it, the other tabs render', async () => {
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-trends-row'));
    await screen.findByTestId('screen-trends');

    // the Periods view: bars with their amounts on top, the current period picked
    const chart = await screen.findByTestId('trends-cat-chart');
    await waitFor(() => expect(screen.getByTestId('trends-cat-current').textContent).toMatch(/€[1-9]/));
    // an amount on every bar that has one; an empty period carries no "€0" (gallery 2026-10-08)
    const amounts = within(chart).getAllByText(/€/);
    expect(amounts.length).toBeGreaterThan(0);
    expect(amounts.length).toBeLessThanOrEqual(12);
    expect(amounts.every((node) => /€[1-9]/.test(node.textContent ?? ''))).toBe(true);
    expect(screen.getByTestId('trends-cat-chart-selected')).toBeTruthy();
    // tapping a bar picks that period: the footer names its range and the door follows
    fireEvent.click(screen.getByTestId('trends-cat-chart-bar-10'));
    expect(screen.getByTestId('trends-cat-current').textContent).not.toContain('This period');
    fireEvent.click(screen.getByTestId('trends-cat-chart-bar-11'));
    expect(screen.getByTestId('trends-cat-current').textContent).toContain('This period');

    // narrowing to a main uses the picker (per-space hidden mains apply)
    fireEvent.click(screen.getByTestId('trends-cat-picker'));
    fireEvent.click(await screen.findByTestId('trends-cat-consumption'));
    await waitFor(() => expect(screen.getByTestId('trends-cat-picker').textContent).toContain('Consumption'));

    fireEvent.click(screen.getByTestId('trends-view-cashflow'));
    await screen.findByTestId('trends-flow-chart');
    expect(screen.getByTestId('trends-flow-net').textContent).toMatch(/€/);

    fireEvent.click(screen.getByTestId('trends-view-networth'));
    await screen.findByTestId('trends-worth-chart');
    // the line ends at the sum of today's balances (LEAN demo — the rich
    // seed with its v2 loan accounts is e2e-only; the specs pin 8,080.55)
    expect(screen.getByTestId('trends-worth-now').textContent).toContain('11,570.55');
  }, 15_000);

  it('vs last period calls out the difference at today’s day and lists the same day of the last four periods; Breakdown splits by subcategory and opens the rows', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    fireEvent.click(screen.getByTestId('trends-graph-view-compare-all'));
    const callout = await screen.findByTestId('trends-compare-callout-all');
    expect(callout.textContent).toMatch(/(less|more) than last period at day [0-9]|Level with last period at day [0-9]/);
    const rows = screen.getByTestId('trends-compare-rows-all');
    expect(within(rows).getAllByTestId(/trends-compare-row-all-/)).toHaveLength(4);
    // the view is remembered per card on this device
    expect(recallGraphView(DEMO_SPACE_ID, 'all')).toBe('compare');

    fireEvent.click(screen.getByTestId('trends-graph-view-breakdown-all'));
    const breakdown = await screen.findByTestId('trends-breakdown-all');
    const first = within(breakdown).getAllByRole('button')[0];
    expect(first.textContent).toMatch(/€[1-9]/);
    expect(first.textContent).toMatch(/%/);
    // a subcategory row opens the transactions behind it, newest first
    fireEvent.click(first);
    const list = await screen.findByTestId('trends-graph-txlist-all');
    await waitFor(() => expect(within(list).getAllByTestId(/^tx-row-/).length).toBeGreaterThan(0));
  }, 15_000);

  it('the Transactions door lists the picked period’s rows in the scope and a row travels to the transaction', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    const door = screen.getByTestId('trends-graph-txs-all');
    await waitFor(() => expect(door.textContent).toMatch(/Transactions · [1-9]/));
    fireEvent.click(door);
    const list = await screen.findByTestId('trends-graph-txlist-all');
    // today's coffee (daysAgo 0) always sits in the current period
    const row = await within(list).findByTestId('tx-row-dm102');
    fireEvent.click(row);
    await screen.findByTestId('screen-tx-detail');
  }, 15_000);

  it('a custom graph is created, edited and deleted — and lives on the space row', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    fireEvent.click(screen.getByTestId('trends-graph-new'));
    const save = await screen.findByTestId('trends-graph-save');
    expect(save.hasAttribute('disabled')).toBe(true); // a name and a category first
    fireEvent.change(screen.getByTestId('trends-graph-name'), { target: { value: 'Food' } });
    fireEvent.click(screen.getByTestId('trends-graph-cat-consumption'));
    // unfolding a main shows its subs ticked through the main
    fireEvent.click(screen.getByTestId('trends-graph-fold-consumption'));
    expect(screen.getByTestId('trends-graph-cat-groceries')).toBeTruthy();
    expect(save.hasAttribute('disabled')).toBe(false);
    fireEvent.click(save);

    // the card appears with the graph's name and charts its scope
    const title = await screen.findByText('Food', {}, { timeout: 5000 });
    const card = title.closest('section')!;
    const id = card.dataset.testid!.replace('trends-graph-', '');
    await waitFor(() => expect(within(card).getByTestId(`trends-graph-txs-${id}`).textContent).toMatch(/Transactions · [1-9]/));
    await waitFor(async () => expect((await readSpace())?.trendGraphs).toEqual([{ id, name: 'Food', catIds: ['consumption'] }]));

    // edit: rename and take groceries out of the main (the other subs stay ticked)
    fireEvent.click(screen.getByTestId(`trends-graph-edit-${id}`));
    const name = await screen.findByTestId('trends-graph-name');
    await waitFor(() => expect((name as HTMLInputElement).value).toBe('Food'));
    fireEvent.change(name, { target: { value: 'Food out' } });
    fireEvent.click(screen.getByTestId('trends-graph-cat-groceries'));
    fireEvent.click(screen.getByTestId('trends-graph-save'));
    await screen.findByText('Food out', {}, { timeout: 5000 });
    await waitFor(async () => {
      const graph = (await readSpace())?.trendGraphs?.[0];
      expect(graph?.name).toBe('Food out');
      expect(graph?.catIds).not.toContain('consumption');
      expect(graph?.catIds).not.toContain('groceries');
      expect(graph?.catIds).toContain('coffee');
    });

    // delete asks once, then the card is gone
    fireEvent.click(screen.getByTestId(`trends-graph-edit-${id}`));
    fireEvent.click(await screen.findByTestId('trends-graph-delete'));
    fireEvent.click(await screen.findByTestId('trends-graph-delete-confirm'));
    await waitFor(() => expect(screen.queryByTestId(`trends-graph-${id}`)).toBeNull(), { timeout: 5000 });
    await waitFor(async () => expect((await readSpace())?.trendGraphs).toEqual([]));
  }, 20_000);

  it('#531: a graph reads only the accounts ticked for it — the card names them, the door counts their rows, the space row keeps the list', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    fireEvent.click(screen.getByTestId('trends-graph-new'));
    await screen.findByTestId('trends-graph-save');
    fireEvent.change(screen.getByTestId('trends-graph-name'), { target: { value: 'Savings spend' } });
    fireEvent.click(screen.getByTestId('trends-graph-cat-consumption'));
    // every account to start with — the ones added later too
    expect(screen.getByTestId('trends-graph-accounts-all').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('trends-graph-accounts-demo_main').getAttribute('aria-pressed')).toBe('true');
    // none ticked is no graph; the savings account alone is
    fireEvent.click(screen.getByTestId('trends-graph-accounts-all'));
    expect(screen.getByTestId('trends-graph-save').hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByTestId('trends-graph-accounts-demo_save'));
    fireEvent.click(screen.getByTestId('trends-graph-save'));
    const title = await screen.findByText('Savings spend', {}, { timeout: 5000 });
    const card = title.closest('section')!;
    const id = card.dataset.testid!.replace('trends-graph-', '');
    expect(within(card).getByTestId(`trends-graph-accounts-${id}`).textContent).toBe('Demo Savings · ING');
    // the demo's groceries are paid from checking: nothing on savings
    await waitFor(() => expect(within(card).getByTestId(`trends-graph-txs-${id}`).textContent).toMatch(/Transactions · 0/));
    await waitFor(async () => expect((await readSpace())?.trendGraphs).toEqual([{ id, name: 'Savings spend', catIds: ['consumption'], accountIds: ['demo_save'] }]));
  }, 20_000);

  it('#455: a graph can leave out what cashed-out goals bought — the card says so and those rows stop counting', async () => {
    // a goal that names today's coffee (dm102) as what it bought, written once the boot chain has settled
    const first = renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    await new Repo(new DexieBackend(db), new HlcClock('seed-goal'), { trackOutbox: false }).upsert('goal', DEMO_SPACE_ID, 'g_machine', {
      name: 'Espresso machine',
      targetCents: 1000,
      allocatedCents: 0,
      archived: 1,
      cashOut: { date: '2026-01-01', txIds: [], purchaseTxIds: ['dm102'] },
    });
    db.close();
    first.unmount();

    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    // two graphs over the same categories: one leaves the goal's purchase out, the other counts everything
    const makeGraph = async (name: string, skipGoals: boolean) => {
      fireEvent.click(screen.getByTestId('trends-graph-new'));
      const field = await screen.findByTestId('trends-graph-name');
      await waitFor(() => expect((field as HTMLInputElement).value).toBe(''));
      fireEvent.change(field, { target: { value: name } });
      fireEvent.click(screen.getByTestId('trends-graph-cat-consumption'));
      const skip = screen.getByTestId('trends-graph-skip-goals') as HTMLInputElement;
      expect(skip.checked).toBe(false);
      if (skipGoals) fireEvent.click(skip);
      expect(skip.checked).toBe(skipGoals);
      fireEvent.click(screen.getByTestId('trends-graph-save'));
      const card = (await screen.findByText(name, {}, { timeout: 5000 })).closest('section')!;
      return card.dataset.testid!.replace('trends-graph-', '');
    };
    const lean = await makeGraph('Day to day', true);
    const whole = await makeGraph('Everything', false);
    expect(screen.getByTestId(`trends-graph-skipgoals-${lean}`).textContent).toBe('Without goal purchases');
    expect(screen.queryByTestId(`trends-graph-skipgoals-${whole}`)).toBeNull();
    await waitFor(async () =>
      expect((await readSpace())?.trendGraphs).toEqual([
        { id: lean, name: 'Day to day', catIds: ['consumption'], skipGoalSpending: true },
        { id: whole, name: 'Everything', catIds: ['consumption'] },
      ]),
    );
    // the door's own span: the period's dates follow it in the button
    const rowsCounted = (id: string) => Number(/· (\d+)$/.exec(screen.getByTestId(`trends-graph-txs-${id}`).querySelector('span')?.textContent ?? '')?.[1] ?? 0);
    await waitFor(() => {
      expect(rowsCounted(whole)).toBeGreaterThan(1);
      expect(rowsCounted(lean)).toBe(rowsCounted(whole) - 1);
    });

    // the option taken off again: the coffee counts, the note is gone
    fireEvent.click(screen.getByTestId(`trends-graph-edit-${lean}`));
    const again = (await screen.findByTestId('trends-graph-skip-goals')) as HTMLInputElement;
    await waitFor(() => expect(again.checked).toBe(true));
    fireEvent.click(again);
    fireEvent.click(screen.getByTestId('trends-graph-save'));
    await waitFor(() => expect(rowsCounted(lean)).toBe(rowsCounted(whole)), { timeout: 5000 });
    expect(screen.queryByTestId(`trends-graph-skipgoals-${lean}`)).toBeNull();
    await waitFor(async () => expect((await readSpace())?.trendGraphs?.[0]).toEqual({ id: lean, name: 'Day to day', catIds: ['consumption'] }));
  }, 30_000);

  it('#531: the Cash flow tab composes its own balance lines — the money in hand ticked to start with, any accounts picked — edited and deleted on the space row', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    fireEvent.click(screen.getByTestId('trends-view-cashflow'));
    await screen.findByTestId('trends-flow-chart');
    fireEvent.click(screen.getByTestId('trends-flow-new'));
    await screen.findByTestId('trends-graph-save');
    // a balance line starts from the money in hand — checking, savings and the cash wallet — and has no "every account" choice
    expect(screen.queryByTestId('trends-graph-accounts-all')).toBeNull();
    const wallet = `trends-graph-accounts-${cashWalletId(DEMO_SPACE_ID)}`;
    expect(screen.getByTestId('trends-graph-accounts-demo_main').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('trends-graph-accounts-demo_save').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId(wallet).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('trends-graph-cats')).toBeNull();
    fireEvent.change(screen.getByTestId('trends-graph-name'), { target: { value: 'Rainy day' } });
    fireEvent.click(screen.getByTestId('trends-graph-accounts-demo_main'));
    fireEvent.click(screen.getByTestId(wallet));
    fireEvent.click(screen.getByTestId('trends-graph-save'));
    const title = await screen.findByText('Rainy day', {}, { timeout: 5000 });
    const card = title.closest('section')!;
    const id = card.dataset.testid!.replace('trends-flow-graph-', '');
    // the line ends at the savings balance alone
    await waitFor(() => expect(within(card).getByTestId(`trends-flow-scrub-${id}`).textContent).toMatch(/Now €8,150\.00/));
    expect(within(card).getByTestId(`trends-flow-accounts-${id}`).textContent).toBe('Demo Savings · ING');
    await waitFor(async () => expect((await readSpace())?.cashflowGraphs).toEqual([{ id, name: 'Rainy day', accountIds: ['demo_save'] }]));
    // the built-in card stays the money in hand
    expect(screen.getByTestId('trends-flow-card').textContent).toContain('Money in hand');

    fireEvent.click(screen.getByTestId(`trends-flow-edit-${id}`));
    fireEvent.click(await screen.findByTestId('trends-graph-delete'));
    fireEvent.click(await screen.findByTestId('trends-graph-delete-confirm'));
    await waitFor(() => expect(screen.queryByTestId(`trends-flow-graph-${id}`)).toBeNull(), { timeout: 5000 });
    await waitFor(async () => expect((await readSpace())?.cashflowGraphs).toEqual([]));
  }, 20_000);

  it('#510: vs last period reads any day — the tip names both periods, the callout and the list follow, Escape goes back to today', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    fireEvent.click(screen.getByTestId('trends-graph-view-compare-all'));
    const chart = await screen.findByTestId('trends-compare-chart-all');
    // the demo's rows first: today's callout carries an amount
    await waitFor(() => expect(screen.getByTestId('trends-compare-callout-all').textContent).toMatch(/€[1-9]/));
    const today = screen.getByTestId('trends-compare-callout-all').textContent;
    fireEvent.keyDown(chart, { key: 'Home' });
    expect(screen.getByTestId('trends-compare-chart-all-tip').textContent).toMatch(/^Day 1/);
    expect(screen.getByTestId('trends-compare-callout-all').textContent).toMatch(/day 1$/);
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.queryByTestId('trends-compare-chart-all-tip')).toBeNull();
    expect(screen.getByTestId('trends-compare-callout-all').textContent).toBe(today);
  }, 15_000);

  it('cash flow: the balance line scrubs into the footer; Range draws the band with the typical peak and low', async () => {
    renderApp('/trends');
    await screen.findByTestId('trends-cat-chart');
    fireEvent.click(screen.getByTestId('trends-view-cashflow'));
    const chart = await screen.findByTestId('trends-flow-chart');
    expect(screen.getByTestId('trends-flow-chart-today')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('trends-flow-scrub').textContent).toMatch(/^Now €/));
    // the keys scrub too — the footer mirrors the day under the guide
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(screen.getByTestId('trends-flow-scrub').textContent).not.toMatch(/^Now/);
    expect(screen.getByTestId('trends-flow-scrub').textContent).toMatch(/€/);
    fireEvent.keyDown(chart, { key: 'Escape' });
    expect(screen.getByTestId('trends-flow-scrub').textContent).toMatch(/^Now €/);

    fireEvent.click(screen.getByTestId('trends-flow-mode-range'));
    const range = await screen.findByTestId('trends-flow-range-chart');
    expect(screen.getByTestId('trends-flow-range-chart-band')).toBeTruthy();
    expect(screen.getByTestId('trends-flow-typical').textContent).toMatch(/Typical payday peak €[1-9].*typical pre-payday low €/);
    // a tapped period names its own low and high
    fireEvent.click(within(range).getByTestId('trends-flow-range-chart-dot-0-1'));
    expect(screen.getByTestId('trends-flow-range-sel').textContent).toMatch(/Low €.* on .* · High €.* on /);
  }, 15_000);

  it('an account in another currency joins a balance line at its worth in the space’s currency — the built-in card and a line of its own', async () => {
    const first = renderApp('/trends');
    await screen.findByTestId('screen-trends');
    // the boot chain settles before the seed opens its own connection
    await (globalThis as { __munniBootChain?: Promise<unknown> }).__munniBootChain;
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('seed-usd'), { trackOutbox: false });
    await repo.upsert('account', DEMO_SPACE_ID, 'acc_usd', { name: 'Dollar savings', type: 'savings', source: 'manual', currency: 'USD', balanceCents: 100_000 });
    await repo.upsert('space', DEMO_SPACE_ID, DEMO_SPACE_ID, { cashflowGraphs: [{ id: 'g_usd', name: 'Dollars', accountIds: ['acc_usd'] }] });
    // the rate Home's sums convert with: a profile without a server pins its own pair
    const profile = ((await db.meta.get('profile'))?.value ?? {}) as Record<string, unknown>;
    await db.meta.put({ key: 'profile', value: { ...profile, displayCurrency: 'EUR' } });
    await db.meta.put({ key: 'fxManualRates', value: { 'USD>EUR': 0.5 } });
    db.close();
    first.unmount();

    renderApp('/trends');
    fireEvent.click(await screen.findByTestId('trends-view-cashflow'));
    // €3,420.55 + €8,150.00 and $1,000.00 at two dollars to the euro
    await waitFor(() => expect(screen.getByTestId('trends-flow-scrub').textContent).toMatch(/^Now €12,070\.55/), { timeout: 5000 });
    expect(screen.getByTestId('trends-flow-scrub-g_usd').textContent).toMatch(/^Now €500\.00/);
    fireEvent.click(screen.getByTestId('trends-view-networth'));
    await waitFor(() => expect(screen.getByTestId('trends-worth-now').textContent).toBe('€12,070.55'));
  }, 20_000);
});

describe('trends format helpers', () => {
  it('compactMoney: whole euros under a thousand, one decimal to ten thousand, none beyond', () => {
    expect(compactMoney(80_800, 'EUR', 'en')).toBe('€808');
    expect(compactMoney(193_800, 'EUR', 'en')).toBe('€1.9K');
    expect(compactMoney(1_234_500, 'EUR', 'en')).toBe('€12K');
    expect(compactMoney(0, 'EUR', 'en')).toBe('€0');
    expect(compactMoney(193_800, 'XXX', 'en')).toBe('1.9K'); // #254: a wallet without a currency
  });

  it('truncateLabel keeps short names and ellipsises long ones; the view memory survives a bad store', () => {
    expect(truncateLabel('Demo Corp')).toBe('Demo Corp');
    expect(truncateLabel('Demo Corp BV Salaris')).toBe('Demo Corp…');
    rememberGraphView('s', 'g', 'breakdown');
    expect(recallGraphView('s', 'g')).toBe('breakdown');
    localStorage.setItem('munni_trend_view_s_g', 'nonsense');
    expect(recallGraphView('s', 'g')).toBe('periods');
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(recallGraphView('s', 'g')).toBe('periods');
    spy.mockRestore();
  });
});
