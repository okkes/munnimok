// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { OVERVIEW_KINDS } from '@/domain/overview';
import { renderApp } from '@/test/harness';
import { periodDelta, periodLabels } from './PeriodsScreen';

// /€[1-9]/ (not /€\d/) so the assertion cannot pass on the €0.00 that
// renders before the live query has delivered the seeded transactions
describe('Periods (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('home links to the periods screen: the current period first, six cards with a chart each, the arrows walk back and forth', async () => {
    renderApp('/home');
    await screen.findByTestId('home-overview-expense');
    expect(screen.getByTestId('home-period-range').textContent).toMatch(/–/);
    fireEvent.click(screen.getByTestId('home-periods-all'));
    await screen.findByTestId('screen-periods');
    expect(screen.getByTestId('periods-caption').textContent).toBe('This period');
    await waitFor(() => expect(screen.getByTestId('periods-value-expense').textContent).toMatch(/€[1-9]/));
    for (const kind of OVERVIEW_KINDS) {
      expect(screen.getByTestId(`periods-card-${kind}`)).toBeTruthy();
      expect(screen.getByTestId(`periods-chart-${kind}`)).toBeTruthy();
    }
    expect(screen.getByTestId('periods-legend').textContent).toContain('so far');
    expect((screen.getByTestId('periods-newer') as HTMLButtonElement).disabled).toBe(true);

    const current = screen.getByTestId('periods-range').textContent;
    fireEvent.click(screen.getByTestId('periods-older'));
    expect(screen.getByTestId('periods-caption').textContent).toBe('Previous period');
    expect(screen.getByTestId('periods-range').textContent).not.toBe(current);
    expect((screen.getByTestId('periods-newer') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId('periods-newer'));
    expect(screen.getByTestId('periods-caption').textContent).toBe('This period');
    expect(screen.getByTestId('periods-range').textContent).toBe(current);
  });

  it('a dot selects that period on every card, the oldest one has nothing to compare with, and a tile opens the drill-down', async () => {
    renderApp('/periods');
    await screen.findByTestId('screen-periods');
    await waitFor(() => expect(screen.getByTestId('periods-value-expense').textContent).toMatch(/€[1-9]/));
    // the solid series (0) owns every closed period's dot; its first one is the oldest on record
    fireEvent.click(screen.getByTestId('periods-chart-expense-dot-0-0'));
    expect(screen.getByTestId('periods-caption').textContent).not.toBe('This period');
    expect(screen.getByTestId('periods-delta-income').textContent).toBe('the first period on record');
    expect(screen.getByTestId('periods-delta-expense').textContent).toBe('the first period on record');
    expect((screen.getByTestId('periods-older') as HTMLButtonElement).disabled).toBe(true);
    // one step forward has a period before it to compare with
    fireEvent.click(screen.getByTestId('periods-newer'));
    expect(screen.getByTestId('periods-delta-expense').textContent).not.toBe('the first period on record');

    fireEvent.click(screen.getByTestId('periods-open-expense'));
    await screen.findByTestId('screen-overview');
  });

  it('the helpers: the delta against the period before and the sparse labels', () => {
    expect(periodDelta([100, 150, 150], 0)).toBeNull();
    expect(periodDelta([100, 150, 150], 1)).toEqual({ cents: 50, pct: 50 });
    expect(periodDelta([0, 150], 1)).toEqual({ cents: 150, pct: null });
    expect(periodDelta([100, 150, 150], 2)).toEqual({ cents: 0, pct: 0 });
    expect(periodDelta([-200, -100], 1)).toEqual({ cents: 100, pct: 50 });

    const monthly = Array.from({ length: 12 }, (_, i) => {
      const m = String(i + 1).padStart(2, '0');
      return { start: `2026-${m}-01`, end: `2026-${m}-28` };
    });
    const labels = periodLabels(monthly, 'month', 'en');
    expect(labels[11]).toBe('Dec');
    expect(labels[10]).toBe('');
    expect(labels[9]).toBe('Oct');
    expect(labels.filter(Boolean)).toHaveLength(6);
    expect(periodLabels(monthly.slice(0, 3), 'week', 'en')).toEqual(['1 Jan', '1 Feb', '1 Mar']);
  });
});
