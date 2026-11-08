// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderApp } from '@/test/harness';

/** a long-running debt makes the acceleration detector fire deterministically */
async function createBigDebt() {
  renderApp('/debts');
  await screen.findByTestId('screen-debts');
  // loans v2: the "+" opens the account chooser — the loan IS an account
  fireEvent.click(await screen.findByTestId('debts-add'));
  fireEvent.click(await screen.findByTestId('chooser-accttype-loan'));
  fireEvent.change(await screen.findByTestId('chooser-acctform-name'), { target: { value: 'Student loan' } });
  fireEvent.change(screen.getByTestId('chooser-acctform-balance'), { target: { value: '25000' } });
  fireEvent.change(screen.getByTestId('chooser-acctform-original'), { target: { value: '25000' } });
  fireEvent.change(screen.getByTestId('chooser-acctform-apr'), { target: { value: '8' } });
  fireEvent.change(screen.getByTestId('chooser-acctform-payment'), { target: { value: '300' } });
  fireEvent.click(screen.getByTestId('chooser-acctform-save'));
  await waitFor(() => expect(document.querySelector('[data-testid^="debt-card-"]')).toBeTruthy());
}

describe('Insights (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
  });

  it('a detector finding renders, expands with detail, and dismisses for good', async () => {
    await createBigDebt();

    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    const head = await waitFor(
      () => {
        const el = document.querySelector('[data-testid^="insight-head-debtacc"]');
        expect(el).toBeTruthy();
        return el!;
      },
      { timeout: 5000 },
    );
    expect(head.textContent).toContain('Student loan');

    fireEvent.click(head);
    const body = await waitFor(() => {
      const el = document.querySelector('[data-testid^="insight-body-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    expect(body.textContent).toMatch(/months earlier/);

    fireEvent.click(screen.getByTestId('insight-dismiss'));
    // synced dismissal: gone now, still gone on a fresh mount. Other
    // detectors (weekend spending) may legitimately fire depending on how
    // the demo seed's relative dates land on the calendar — only the
    // dismissed finding must stay away, not the whole screen.
    await waitFor(() => expect(document.querySelector('[data-testid^="insight-head-debtacc"]')).toBeNull());
    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    await waitFor(() => {
      const settled =
        screen.queryByTestId('insights-empty') ?? document.querySelector('[data-testid^="insight-head-"]');
      expect(settled).toBeTruthy();
    }, { timeout: 5000 });
    expect(document.querySelector('[data-testid^="insight-head-debtacc"]')).toBeNull();
  }, 20_000);

  it('#516: findings that give the same advice share one card — it lists each, a line opens its fix, Dismiss all clears it for good', async () => {
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    const sub = (id: string, name: string, catId: string, amountCents: number) =>
      repo.upsert('recurring', 'demo_space', id, { name, kind: 'subscription', catId, amountCents, every: 'month', dueDay: 3, active: 1 });
    await sub('ov1', 'Netflix', 'subs', 1_399);
    await sub('ov2', 'Disney+', 'subs', 999);
    await sub('ov3', 'Basic-Fit', 'gym', 2_999);
    await sub('ov4', 'SportCity', 'gym', 3_499);
    db.close();

    cleanup();
    renderApp('/insights');
    const head = await screen.findByTestId('insight-head-group:overlap', {}, { timeout: 5000 });
    expect(head.textContent).toMatch(/Overlapping subscriptions in 2 categories/);
    // the card sums what the two pairs cost a year: (13.99 + 9.99 + 29.99 + 34.99) × 12
    expect(screen.getByTestId('insight-sub-group:overlap').textContent).toMatch(/€1,067[.,]52 per year/);
    fireEvent.click(head);
    const lines = await screen.findByTestId('insight-lines-group:overlap');
    // each line names its category and the subscriptions in it
    expect(lines.textContent).toMatch(/Streaming: Disney\+ \+ Netflix · €23[.,]98 per month/);
    expect(lines.textContent).toContain('Basic-Fit + SportCity');

    fireEvent.click(screen.getByTestId('insight-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('insight-head-group:overlap')).toBeNull());
    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    await waitFor(() => {
      const settled = screen.queryByTestId('insights-empty') ?? document.querySelector('[data-testid^="insight-head-"]');
      expect(settled).toBeTruthy();
    }, { timeout: 5000 });
    expect(document.querySelector('[data-testid*="overlap"]')).toBeNull();
  }, 20_000);

  it('a line of a shared card opens where its fix lives', async () => {
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    const { MunniDB } = await import('@/db/schema');
    const { Repo } = await import('@/db/repo');
    const { DexieBackend } = await import('@/db/backend');
    const { HlcClock } = await import('@/sync/hlc');
    const db = new MunniDB('munni_demo');
    const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    for (const [id, catId] of [['a1', 'subs'], ['a2', 'subs'], ['b1', 'gym'], ['b2', 'gym']]) {
      await repo.upsert('recurring', 'demo_space', id, { name: id, kind: 'subscription', catId, amountCents: 1_000, every: 'month', dueDay: 3, active: 1 });
    }
    db.close();

    cleanup();
    renderApp('/insights');
    fireEvent.click(await screen.findByTestId('insight-head-group:overlap', {}, { timeout: 5000 }));
    fireEvent.click(await screen.findByTestId('insight-line-overlap:gym:2'));
    expect(await screen.findByTestId('screen-recurring')).toBeTruthy();
  }, 20_000);

  it('the weekly digest notifies once and the marker holds it back after', async () => {
    const shown: string[] = [];
    vi.stubGlobal('Notification', { permission: 'granted' } as unknown as typeof Notification);
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { ready: Promise.resolve({ showNotification: (title: string) => { shown.push(title); return Promise.resolve(); } }) },
    });

    await createBigDebt();
    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    await waitFor(() => expect(shown).toHaveLength(1), { timeout: 5000 });

    // same ISO week, fresh mount: quiet
    cleanup();
    renderApp('/insights');
    await screen.findByTestId('screen-insights');
    await waitFor(() => expect(document.querySelector('[data-testid^="insight-head-"]')).toBeTruthy(), { timeout: 5000 });
    expect(shown).toHaveLength(1);
  }, 20_000);

  it('the home block surfaces the top insight; the settings row reaches the screen', async () => {
    await createBigDebt();

    cleanup();
    renderApp('/home');
    // the TOP insight may be the calendar-dependent weekend detector
    // instead of the seeded debt — the block just has to surface one
    const block = await screen.findByTestId('home-insight', {}, { timeout: 5000 });
    expect(block.textContent?.length).toBeGreaterThan(0);
    fireEvent.click(block);
    await screen.findByTestId('screen-insights');
    // …and the debt finding is on the full screen either way
    await waitFor(() => expect(document.querySelector('[data-testid^="insight-head-debtacc"]')).toBeTruthy(), {
      timeout: 5000,
    });

    cleanup();
    renderApp('/settings');
    await screen.findByTestId('screen-settings');
    fireEvent.click(screen.getByTestId('settings-insights-row'));
    expect(await screen.findByTestId('screen-insights')).toBeTruthy();
  }, 20_000);
});
