// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderApp, renderAppAsUser } from '@/test/harness';
import type { PushState } from '@/application/pushState';

/** the device's notification state, set per test (#534) */
const device = vi.hoisted(() => ({ push: 'on' as PushState | null }));
vi.mock('@/application/pushState', () => ({ usePushState: () => device.push }));

const chip = (pct: number) => screen.getByTestId(`budgetform-notify-${pct}`) as HTMLButtonElement;

describe('the budget form (#534)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
    device.push = 'on';
  });

  it('the name comes first, then the icons — no picture of your own', async () => {
    renderApp('/budgets/new');
    const name = await screen.findByTestId('budgetform-name');
    const search = screen.getByTestId('budgetform-icon-search');
    expect(name.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('budgetform-icon-wallet-outline').getAttribute('aria-pressed')).toBe('true');
  });

  it('with notifications on, a warning threshold is picked, saved and read back', async () => {
    renderApp('/budgets/new');
    await screen.findByTestId('screen-budget-form');
    expect(screen.queryByTestId('budgetform-notify-why-toggle')).toBeNull();
    fireEvent.change(screen.getByTestId('budgetform-name'), { target: { value: 'Fun' } });
    fireEvent.change(screen.getByTestId('budgetform-amount'), { target: { value: '50' } });
    fireEvent.click(await screen.findByTestId('budget-cat-entertainment'));
    fireEvent.click(chip(90));
    fireEvent.click(screen.getByTestId('budgetform-save'));
    await screen.findByTestId('screen-budgets');
    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="budget-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('budgetdetail-edit'));
    await waitFor(() => expect((screen.getByTestId('budgetform-name') as HTMLInputElement).value).toBe('Fun'));
    expect(chip(90).getAttribute('aria-pressed')).toBe('true');
  }, 15_000);

  it('with notifications off the choice rests, and the info says why and where to switch them on', async () => {
    device.push = 'off';
    renderApp('/budgets/new');
    await screen.findByTestId('screen-budget-form');
    for (const pct of [0, 80, 90, 100]) expect(chip(pct).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('budgetform-notify-why-toggle'));
    expect(screen.getByTestId('budgetform-notify-why').textContent).toMatch(/notifications are off for this space on this device.*Settings → Notifications/);
  });

  it('a profile without an account, or a device that cannot be reached, is told so', async () => {
    device.push = 'no-account';
    renderApp('/budgets/new');
    await screen.findByTestId('screen-budget-form');
    expect(chip(80).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('budgetform-notify-why-toggle'));
    expect(screen.getByTestId('budgetform-notify-why').textContent).toMatch(/Sign in with an account/);
  });
});

describe('the budget form, signed in', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    device.push = 'on';
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a choice taken back reaches the server: Off, an emptied reset day and carry-over switched off travel as null', async () => {
    // what the server is sent for the budget, as the JSON it arrives in
    const sent: Record<string, unknown>[] = [];
    renderAppAsUser('/budgets/new', {
      api: {
        'POST /sync/s-user/push': (body) => {
          for (const op of (body as { ops: { entity: string; fields: Record<string, unknown> }[] }).ops) if (op.entity === 'budget') sent.push(op.fields);
          return { lastSeq: 0 };
        },
      },
    });
    await screen.findByTestId('screen-budget-form');
    fireEvent.change(screen.getByTestId('budgetform-name'), { target: { value: 'Fun' } });
    fireEvent.change(screen.getByTestId('budgetform-amount'), { target: { value: '50' } });
    fireEvent.click(await screen.findByTestId('budget-cat-entertainment'));
    fireEvent.change(screen.getByTestId('budgetform-resetday'), { target: { value: '12' } });
    fireEvent.click(screen.getByTestId('budgetform-carry'));
    fireEvent.click(await screen.findByTestId('budgetform-carrymode-cap'));
    fireEvent.change(screen.getByTestId('budgetform-carrycap'), { target: { value: '150' } });
    fireEvent.click(chip(90));
    fireEvent.click(screen.getByTestId('budgetform-save'));
    await screen.findByTestId('screen-budgets');
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ notifyAtPct: 90, resetDay: 12, carryMode: 'cap', carryCapCents: 15_000 }));

    const card = await waitFor(() => {
      const el = document.querySelector('[data-testid^="budget-card-"]');
      expect(el).toBeTruthy();
      return el!;
    });
    fireEvent.click(card);
    fireEvent.click(await screen.findByTestId('budgetdetail-edit'));
    await waitFor(() => expect((screen.getByTestId('budgetform-resetday') as HTMLInputElement).value).toBe('12'));
    fireEvent.click(chip(0));
    fireEvent.change(screen.getByTestId('budgetform-resetday'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('budgetform-carry'));
    fireEvent.click(screen.getByTestId('budgetform-save'));
    await waitFor(() => expect(sent.at(-1)).toMatchObject({ notifyAtPct: null, resetDay: null, carryOver: 0, carryMode: null, carryPeriods: null, carryCapCents: null }));
  }, 20_000);
});
