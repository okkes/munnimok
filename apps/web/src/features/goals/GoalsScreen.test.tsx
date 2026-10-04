// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

async function createGoal(name: string, target: string) {
  fireEvent.click(await screen.findByTestId('goals-add'));
  await screen.findByTestId('goalform-name');
  fireEvent.change(screen.getByTestId('goalform-name'), { target: { value: name } });
  fireEvent.change(screen.getByTestId('goalform-target'), { target: { value: target } });
  fireEvent.click(screen.getByTestId('goalform-save'));
  await waitFor(() => {
    expect(document.querySelector('[data-testid^="goal-card-"]')).toBeTruthy();
  });
  return document.querySelector('[data-testid^="goal-card-"]')!;
}

// the sheet's close animation never finishes in happy-dom, so completion
// is observed on the numbers, not on the sheet unmounting
async function fund(kind: 'goaldetail-fund' | 'goaldetail-withdraw', amount: string, expected: RegExp) {
  fireEvent.click(screen.getByTestId(kind));
  const input = await screen.findByTestId('goalfund-amount');
  fireEvent.change(input, { target: { value: amount } });
  fireEvent.click(screen.getByTestId('goalfund-save'));
  // the input resets in the same batch as the sheet close — once it's
  // empty, the stale close can no longer race the next open
  await waitFor(() => expect((screen.getByTestId('goalfund-amount') as HTMLInputElement).value).toBe(''));
  await waitFor(() => expect(screen.getByTestId('goaldetail-allocated').textContent).toMatch(expected), { timeout: 5000 });
}

describe('Goals (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('creates a goal; the header shows the savings honesty numbers', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    await screen.findByTestId('goals-empty');

    // the form offers the goal-themed covers, not the event scenes
    fireEvent.click(await screen.findByTestId('goals-add'));
    await screen.findByTestId('goalform-pic-house');
    expect(screen.queryByTestId('goalform-pic-beach')).toBeNull();

    const card = await createGoal('New car', '1000');
    expect(card.textContent).toContain('New car');
    // demo savings account holds €8,150 — saved and unallocated show it
    const overview = screen.getByTestId('goals-overview');
    await waitFor(() => expect(overview.textContent).toMatch(/8.150/));
    expect(screen.queryByTestId('goals-negative-note')).toBeNull();
  }, 15_000);

  it('#449 + user 2026-10-04: the card says what is left and the pace per period; the page says how many times', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    fireEvent.click(await screen.findByTestId('goals-add'));
    await screen.findByTestId('goalform-name');
    fireEvent.change(screen.getByTestId('goalform-name'), { target: { value: 'England' } });
    fireEvent.change(screen.getByTestId('goalform-target'), { target: { value: '1000' } });
    // the demo space counts monthly from the 1st: a date next month is two
    // periods away - this one and the next - so the thousand splits in two
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 15);
    fireEvent.change(screen.getByTestId('goalform-date'), { target: { value: next.toISOString().slice(0, 10) } });
    fireEvent.click(screen.getByTestId('goalform-save'));
    const card = await waitFor(() => {
      const found = document.querySelector('[data-testid^="goal-card-"]');
      expect(found).toBeTruthy();
      return found as HTMLElement;
    });
    expect(card.textContent).toMatch(/€1,000[.,]00 to go/);
    expect(card.textContent).toMatch(/€500[.,]00 \u002f month/);

    fireEvent.click(card);
    expect((await screen.findByTestId('goaldetail-togo')).textContent).toMatch(/€1,000[.,]00 to go/);
    expect(screen.getByTestId('goaldetail-pace').textContent).toMatch(/€500[.,]00 per month, 2 more times/);
  }, 15_000);

  it('funding and withdrawing move the allocation and write history', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('Bike', '500');

    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    await fund('goaldetail-fund', '100', /€100[.,]00/);
    await fund('goaldetail-withdraw', '40', /€60[.,]00/);

    const history = screen.getByTestId('goaldetail-history');
    expect(history.textContent).toContain('+€100.00');
    expect(history.textContent).toMatch(/-€40[.,]00/);
  }, 15_000);

  it('allocating more than the savings balance flags the rebalance note', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('House', '20000');

    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    // €8,000 into €8,150 of savings is fine; the savings then drop to
    // €5,000 → unallocated −€3,000 (user must fix it)
    await fund('goaldetail-fund', '8000', /€8[.,]000[.,]00/);
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.accounts.update('demo_save', { balanceCents: 500_000 });
    db.close();

    cleanup();
    renderApp('/goals');
    const note = await screen.findByTestId('goals-negative-note', {}, { timeout: 5000 });
    expect(note.textContent).toMatch(/3[.,]000/);
  }, 15_000);

  it('#368: funding beyond the savings pool is refused with what is left; the pool is the ticked savings accounts', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    const card = await createGoal('House', '20000');
    fireEvent.click(card);
    await screen.findByTestId('goaldetail-hero');
    fireEvent.click(screen.getByTestId('goaldetail-fund'));
    fireEvent.change(await screen.findByTestId('goalfund-amount'), { target: { value: '9000' } });
    await waitFor(() => expect(screen.getByTestId('goalfund-pool').textContent).toMatch(/8[.,]150/));
    fireEvent.click(screen.getByTestId('goalfund-save'));
    await screen.findByTestId('goalfund-pool-blocker');
    expect(screen.getByTestId('goaldetail-allocated').textContent).toMatch(/€0[.,]00/);

    cleanup();
    renderApp('/goals');
    await waitFor(() => expect(screen.getByTestId('goals-overview-saved').textContent).toMatch(/8[.,]150/));
    fireEvent.click(screen.getByTestId('goals-pool-toggle'));
    fireEvent.click(await screen.findByTestId('goalpool-acct-demo_save'));
    await waitFor(() => expect(screen.getByTestId('goals-overview-saved').textContent).toMatch(/€0[.,]00/), { timeout: 5000 });
  }, 20_000);

  it('#368: a goal due within three months is pointed at allocation', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    fireEvent.click(await screen.findByTestId('goals-add'));
    await screen.findByTestId('goalform-name');
    const soon = new Date();
    soon.setMonth(soon.getMonth() + 2);
    fireEvent.change(screen.getByTestId('goalform-date'), { target: { value: soon.toISOString().slice(0, 10) } });
    await screen.findByTestId('goalform-shortterm');
    fireEvent.click(screen.getByTestId('goalform-shortterm-go'));
    expect(await screen.findByTestId('screen-planning')).toBeTruthy();
  }, 15_000);

  it('the home block surfaces progress; the settings row reaches goals', async () => {
    renderApp('/goals');
    await screen.findByTestId('screen-goals');
    await createGoal('New car', '1000');

    cleanup();
    renderApp('/home');
    const block = await screen.findByTestId('home-goals', {}, { timeout: 5000 });
    expect(block.textContent).toContain('New car');
    fireEvent.click(screen.getByTestId('home-goals-all'));
    await screen.findByTestId('screen-goals');

    cleanup();
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-goals-row'));
    await screen.findByTestId('screen-goals');
  }, 15_000);
});
