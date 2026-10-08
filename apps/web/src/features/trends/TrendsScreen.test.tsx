// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';
import { DEMO_SPACE_ID } from '@/db/seed';
import { MunniDB } from '@/db/schema';
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

  it('the opt-in net-worth home block appears via Customize Home', async () => {
    renderApp('/home');
    await screen.findByTestId('screen-home');
    expect(screen.queryByTestId('home-networth')).toBeNull(); // hidden by default

    // customize lives on its own screen now (user request) — toggle
    // there, then back to Home for the payoff
    fireEvent.click(screen.getByTestId('home-customize'));
    await screen.findByTestId('home-customize-list');
    fireEvent.click(screen.getByTestId('home-block-toggle-networth'));
    fireEvent.click(screen.getByTestId('tab-home'));
    const block = await screen.findByTestId('home-networth', {}, { timeout: 5000 });
    expect(block.textContent).toContain('11,570.55');
  }, 15_000);
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
