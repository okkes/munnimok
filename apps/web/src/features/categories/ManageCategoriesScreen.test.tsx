// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderApp } from '@/test/harness';

const openScreen = async () => {
  renderApp('/categories');
  await screen.findByTestId('managecat-groceries');
};

describe('ManageCategoriesScreen (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('lists built-in categories as read-only rows', async () => {
    await openScreen();
    const row = screen.getByTestId('managecat-groceries');
    expect((row as HTMLButtonElement).disabled).toBe(true);
    expect(row.textContent).not.toContain('Custom');
  });

  it('creates a custom MAIN category with type, color and a locked Other sub', async () => {
    await openScreen();
    fireEvent.click(screen.getByTestId('cats-add'));
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Music lessons' } });
    fireEvent.click(screen.getByTestId('catform-type-income'));
    fireEvent.click(screen.getByTestId('catform-color-3498DB'));
    fireEvent.click(screen.getByTestId('catform-icon-laptop'));
    fireEvent.click(screen.getByTestId('catform-save'));

    // the new main appears as a group header with its type badge…
    // (generous timeout: coverage instrumentation slows the live query)
    await waitFor(() => expect(screen.getByText('Music lessons')).toBeTruthy(), { timeout: 5000 });
    const header = screen.getByText('Music lessons').closest('.m-cap')!;
    expect(header.textContent).toContain('Income');
    // …and the auto "Other" sub exists but is not editable
    const group = header.parentElement!;
    const other = [...group.querySelectorAll('[data-testid^="managecat-"]')].find((b) =>
      b.textContent?.includes('Other'),
    ) as HTMLButtonElement;
    expect(other).toBeTruthy();
    expect(other.disabled).toBe(true);
  });

  it('creates a sub with a direction under a builtin parent (type inherited)', async () => {
    await openScreen();
    fireEvent.click(screen.getByTestId('cats-addsub-sport'));
    expect((await screen.findByTestId('catform-inherited-type')).textContent).toBe('Expense');
    fireEvent.change(screen.getByTestId('catform-name'), { target: { value: 'Padel' } });
    fireEvent.click(screen.getByTestId('catform-direction-debit'));
    fireEvent.click(screen.getByTestId('catform-icon-dumbbell'));
    fireEvent.click(screen.getByTestId('catform-save'));

    const custom = await screen.findByText('Padel');
    expect(custom.closest('button')!.textContent).toContain('Custom');
  });

  it('renames and deletes an unused custom sub without a warning', async () => {
    await openScreen();
    fireEvent.click(screen.getByTestId('cats-addsub-sport'));
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Padel' } });
    fireEvent.click(screen.getByTestId('catform-save'));
    const row = (await screen.findByText('Padel')).closest('button')!;

    fireEvent.click(row);
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Padel & Tennis' } });
    fireEvent.click(screen.getByTestId('catform-save'));
    await waitFor(() => expect(screen.getByText('Padel & Tennis')).toBeTruthy());

    fireEvent.click(screen.getByText('Padel & Tennis').closest('button')!);
    fireEvent.click(await screen.findByTestId('catform-delete'));
    await waitFor(() => expect(screen.queryByText('Padel & Tennis')).toBeNull());
  });

  it('moving a sub via Move to… works instantly when types match', async () => {
    await openScreen();
    fireEvent.click(screen.getByTestId('cats-addsub-sport'));
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Padel' } });
    fireEvent.click(screen.getByTestId('catform-save'));
    const row = (await screen.findByText('Padel')).closest('button')!;

    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId('catform-move-entertainment')); // expense -> expense
    fireEvent.click(screen.getByTestId('catform-save'));
    await waitFor(() => {
      const moved = screen.getByText('Padel').closest('[data-cat-group]');
      expect(moved?.getAttribute('data-cat-group')).toBe('entertainment');
    });
  });
});

describe('category impact warnings (demo identity)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('deleting a category that transactions use warns first, then detaches them', async () => {
    await openScreen();
    // create a sub, assign it to a demo transaction, then delete the sub
    fireEvent.click(screen.getByTestId('cats-addsub-consumption'));
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Doomed' } });
    fireEvent.click(screen.getByTestId('catform-save'));
    const row = (await screen.findByText('Doomed')).closest('button')!;
    const catId = row.getAttribute('data-testid')!.replace('managecat-', '');

    // assign directly through the demo db (dm6 is an expense)
    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.transactions.update('dm6', { catId });
    db.close();

    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId('catform-delete'));
    const warning = await screen.findByTestId('cats-impact-text');
    expect(warning.textContent).toContain('1 transaction');

    fireEvent.click(screen.getByTestId('cats-impact-confirm'));
    await waitFor(() => expect(screen.queryByText('Doomed')).toBeNull());

    const check = new MunniDB('munni_demo');
    const tx = await check.transactions.get('dm6');
    expect(tx?.catId).toBe('uncategorized');
    expect(tx?.needsReview).toBe(1);
    check.close();
  });

  it('cancelling the warning keeps everything unchanged', async () => {
    await openScreen();
    fireEvent.click(screen.getByTestId('cats-addsub-consumption'));
    fireEvent.change(await screen.findByTestId('catform-name'), { target: { value: 'Kept' } });
    fireEvent.click(screen.getByTestId('catform-save'));
    const row = (await screen.findByText('Kept')).closest('button')!;
    const catId = row.getAttribute('data-testid')!.replace('managecat-', '');

    const { MunniDB } = await import('@/db/schema');
    const db = new MunniDB('munni_demo');
    await db.transactions.update('dm6', { catId });
    db.close();

    fireEvent.click(row);
    fireEvent.click(await screen.findByTestId('catform-delete'));
    await screen.findByTestId('cats-impact-text');
    fireEvent.click(screen.getByTestId('cats-impact-cancel'));

    const check = new MunniDB('munni_demo');
    expect((await check.transactions.get('dm6'))?.catId).toBe(catId);
    check.close();
    expect(screen.getByText('Kept')).toBeTruthy();
  });
});
