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
