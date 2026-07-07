// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

describe('ManageCategoriesScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('lists built-in categories as read-only rows', async () => {
    renderApp('/categories');
    const row = await screen.findByTestId('managecat-groceries');
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).not.toContain('Custom');
  });

  it('creates, edits and deletes a custom category', async () => {
    renderApp('/categories');
    await screen.findByTestId('managecat-groceries');

    // create under a chosen parent with a chosen icon
    fireEvent.click(screen.getByTestId('cats-add'));
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Padel' } });
    fireEvent.click(screen.getByTestId('catform-parent-sport'));
    fireEvent.click(screen.getByTestId('catform-icon-dumbbell'));
    fireEvent.click(screen.getByTestId('catform-save'));

    const custom = await screen.findByText('Padel');
    const rowBtn = custom.closest('button')!;
    expect(rowBtn.textContent).toContain('Custom');
    expect((rowBtn as HTMLButtonElement).disabled).toBe(false);

    // edit: rename
    fireEvent.click(rowBtn);
    const nameInput = await screen.findByTestId('catform-name');
    fireEvent.change(nameInput, { target: { value: 'Padel & Tennis' } });
    fireEvent.click(screen.getByTestId('catform-save'));
    await waitFor(() => expect(screen.getByText('Padel & Tennis')).toBeTruthy());

    // delete
    fireEvent.click(screen.getByText('Padel & Tennis').closest('button')!);
    fireEvent.click(await screen.findByTestId('catform-delete'));
    await waitFor(() => expect(screen.queryByText('Padel & Tennis')).toBeNull());
  });
});
