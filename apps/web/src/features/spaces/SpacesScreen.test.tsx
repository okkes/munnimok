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

  // the 'Active space' badge can transiently match zero or two elements
  // mid-render (coverage slows liveQuery), so always resolve inside waitFor
  const activeRow = () =>
    screen
      .getAllByText('Active space')
      .map((el) => el.closest('[data-testid^="space-row-"]'))
      .find(Boolean);
  const findActiveRow = async () => {
    let row: Element | undefined;
    await waitFor(() => {
      row = activeRow() ?? undefined;
      expect(row).toBeTruthy();
    });
    return row!;
  };

  it('shows the demo space as active', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    await findActiveRow();
  });

  it('creates a space and switches to it, then can switch back', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    const first = (await findActiveRow()).getAttribute('data-testid')!;

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
    const id = (await findActiveRow()).getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    fireEvent.change(await screen.findByTestId('space-edit-name'), { target: { value: 'Household' } });
    fireEvent.click(screen.getByTestId('space-edit-save'));
    // save navigates back to the list; live query re-render can lag under load
    await waitFor(() => expect(screen.getByTestId(`space-row-${id}`).textContent).toContain('Household'), {
      timeout: 5000,
    });
  });

  it('saves icon, color, currency, period and history start from the settings sheet', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    const id = (await findActiveRow()).getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    fireEvent.click(await screen.findByTestId('space-icon-briefcase-outline'));
    fireEvent.click(screen.getByTestId('space-color-3498DB'));
    fireEvent.click(screen.getByTestId('space-currency-TRY'));
    fireEvent.click(screen.getByTestId('space-period-week'));
    fireEvent.change(screen.getByTestId('space-history-start'), { target: { value: '2026-01-01' } });
    fireEvent.click(screen.getByTestId('space-edit-save'));

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    // generous timeout: parallel suites slow the Dexie round-trip
    await waitFor(
      async () => {
        const space = await db.spaces.get(id);
        expect(space?.icon).toBe('briefcase-outline');
        expect(space?.color).toBe('#3498DB');
        expect(space?.currency).toBe('TRY');
        expect(space?.periodType).toBe('week');
        expect(space?.historyStartDate).toBe('2026-01-01');
      },
      { timeout: 5000 },
    );
    db.close();

    // the list row shows the chosen icon (live query re-render — must wait)
    await waitFor(
      () => {
        expect(screen.getByTestId(`space-row-${id}`).innerHTML).toContain('briefcase-outline');
      },
      { timeout: 5000 },
    );
  });

  it('monthly period exposes the start-day input, weekly hides it', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    const id = (await findActiveRow()).getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    const day = await screen.findByTestId('space-period-day');
    fireEvent.change(day, { target: { value: '40' } });
    expect((day as HTMLInputElement).value).toBe('28'); // clamped

    fireEvent.click(screen.getByTestId('space-period-biweekly'));
    expect(screen.queryByTestId('space-period-day')).toBeNull();
    // weekly/bi-weekly periods pick a START WEEKDAY instead (legacy parity)
    expect(screen.getByTestId('space-weekday-3')).toBeTruthy();
    fireEvent.click(screen.getByTestId('space-weekday-3'));
    fireEvent.click(screen.getByTestId('space-edit-save'));
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await waitFor(async () => {
      const space = await db.spaces.get(id);
      expect(space?.periodType).toBe('biweekly');
      expect(space?.periodDay).toBe(3); // Wednesday
    });
    db.close();
  });

  it('refuses deleting the active or only space, allows deleting another', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    const firstId = (await findActiveRow()).getAttribute('data-testid')!.replace('space-row-', '');

    // active space cannot be deleted
    fireEvent.click(screen.getByTestId(`space-edit-${firstId}`));
    fireEvent.click(await screen.findByTestId('space-edit-delete'));
    expect(await screen.findByTestId('space-delete-error')).toBeTruthy();
    fireEvent.click(screen.getByTestId('spacesettings-back')); // settings is a screen now

    // create a second space (becomes active), then the first is deletable
    fireEvent.click(await screen.findByTestId('spaces-add'));
    fireEvent.change(await screen.findByTestId('space-create-name'), { target: { value: 'Temp' } });
    fireEvent.click(screen.getByTestId('space-create-save'));
    await waitFor(() => expect(activeRow()!.textContent).toContain('Temp'));

    fireEvent.click(screen.getByTestId(`space-edit-${firstId}`));
    // destructive: first tap arms the confirmation, second tap deletes
    fireEvent.click(await screen.findByTestId('space-edit-delete'));
    expect(await screen.findByTestId('space-delete-confirm-note')).toBeTruthy();
    fireEvent.click(screen.getByTestId('space-edit-delete'));
    await waitFor(() => expect(screen.queryByTestId(`space-row-${firstId}`)).toBeNull());
    // multi-step flow: the default 5s test budget trips under coverage load
  }, 15_000);

  it('lists the accounts attached to the space in its settings', async () => {
    renderApp('/spaces');
    await screen.findByTestId('screen-spaces');
    const id = (await findActiveRow()).getAttribute('data-testid')!.replace('space-row-', '');

    fireEvent.click(screen.getByTestId(`space-edit-${id}`));
    const section = await screen.findByTestId('space-accounts');
    // the demo space owns its seeded accounts directly
    await waitFor(() => expect(section.textContent).toContain('Demo Savings'), { timeout: 5000 });
    expect(screen.getByTestId('space-accounts-manage')).toBeTruthy();
  }, 10_000);
});
