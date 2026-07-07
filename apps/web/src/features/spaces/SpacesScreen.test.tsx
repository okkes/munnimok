// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

describe('SpacesScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  const activeRow = () => screen.getByText('Active space').closest('[data-testid^="space-row-"]');

  it('shows the demo space as active', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await waitFor(() => expect(screen.getByText('Active space')).toBeTruthy());
  });

  it('creates a space and switches to it, then can switch back', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await waitFor(() => expect(screen.getByText('Active space')).toBeTruthy());
    const first = activeRow()!.getAttribute('data-testid')!;

    fireEvent.click(screen.getByTestId('spaces-add'));
    fireEvent.change(await screen.findByTestId('space-create-name'), { target: { value: 'Side hustle' } });
    fireEvent.click(screen.getByTestId('space-create-save'));

    // new space appears and becomes active
    await waitFor(() => {
      expect(screen.getByText('Side hustle')).toBeTruthy();
      expect(activeRow()!.textContent).toContain('Side hustle');
    });

    // switch back to the original space
    fireEvent.click(screen.getByTestId(first));
    await waitFor(() => expect(activeRow()!.getAttribute('data-testid')).toBe(first));
  });

  it('renames a space from the edit sheet', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await waitFor(() => expect(screen.getByText('Active space')).toBeTruthy());
    const id = activeRow()!.getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    fireEvent.change(await screen.findByTestId('space-edit-name'), { target: { value: 'Household' } });
    fireEvent.click(screen.getByTestId('space-edit-save'));
    await waitFor(() => expect(screen.getByTestId(`space-row-${id}`).textContent).toContain('Household'));
  });

  it('saves icon, color, currency, period and history start from the settings sheet', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await waitFor(() => expect(screen.getByText('Active space')).toBeTruthy());
    const id = activeRow()!.getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    fireEvent.click(await screen.findByTestId('space-icon-briefcase-outline'));
    fireEvent.click(screen.getByTestId('space-color-3498DB'));
    fireEvent.click(screen.getByTestId('space-currency-TRY'));
    fireEvent.click(screen.getByTestId('space-period-week'));
    fireEvent.change(screen.getByTestId('space-history-start'), { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByTestId('space-edit-save'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const space = await db.spaces.get(id);
      expect(space?.icon).toBe('briefcase-outline');
      expect(space?.color).toBe('#3498DB');
      expect(space?.currency).toBe('TRY');
      expect(space?.periodType).toBe('week');
      expect(space?.historyStartDate).toBe('2026-01-01');
    });
    db.close();

    // the list row shows the chosen icon color
    const row = screen.getByTestId(`space-row-${id}`);
    expect(row.innerHTML).toContain('briefcase-outline');
  });

  it('monthly period exposes the start-day input, weekly hides it', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await waitFor(() => expect(screen.getByText('Active space')).toBeTruthy());
    const id = activeRow()!.getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    const day = await screen.findByTestId('space-period-day');
    fireEvent.change(day, { target: { value: '40' } });
    expect((day as HTMLInputElement).value).toBe('28'); // clamped

    fireEvent.click(screen.getByTestId('space-period-biweekly'));
    expect(screen.queryByTestId('space-period-day')).toBeNull();
  });

  it('refuses deleting the active or only space, allows deleting another', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await waitFor(() => expect(screen.getByText('Active space')).toBeTruthy());
    const firstId = activeRow()!.getAttribute('data-testid')!.replace('space-row-', '');

    // active space cannot be deleted
    fireEvent.click(screen.getByTestId(`space-edit-${firstId}`));
    fireEvent.click(await screen.findByTestId('space-edit-delete'));
    expect(await screen.findByTestId('space-delete-error')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'Escape' });

    // create a second space (becomes active), then the first is deletable
    fireEvent.click(screen.getByTestId('spaces-add'));
    fireEvent.change(await screen.findByTestId('space-create-name'), { target: { value: 'Temp' } });
    fireEvent.click(screen.getByTestId('space-create-save'));
    await waitFor(() => expect(activeRow()!.textContent).toContain('Temp'));

    fireEvent.click(screen.getByTestId(`space-edit-${firstId}`));
    fireEvent.click(await screen.findByTestId('space-edit-delete'));
    await waitFor(() => expect(screen.queryByTestId(`space-row-${firstId}`)).toBeNull());
  });
});
