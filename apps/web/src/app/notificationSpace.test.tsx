// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

const spaces = [
  { id: 's-user', name: 'Personal' },
  { id: 's-trip', name: 'Trip', kind: 'shared' as const },
];

/** the space this device was in before the notification arrived */
async function startIn(spaceId: string) {
  const db = new MunniDB(USER_TEST_DB);
  await db.meta.put({ key: 'activeSpaceId', value: spaceId });
  db.close();
}

describe('a notification opens its screen in its space (#551)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('arriving with ?space= switches to that space', async () => {
    await startIn('s-user');
    renderAppAsUser('/settings?space=s-trip', { spaces });
    await screen.findByTestId('screen-settings', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('settings-space-row').textContent).toContain('Trip'), { timeout: 5000 });
  }, 15_000);

  it('a new-transactions notification opens the review in its space', async () => {
    await startIn('s-user');
    renderAppAsUser('/review?space=s-trip', { spaces });
    await screen.findByTestId('screen-review', {}, { timeout: 5000 });
    const db = new MunniDB(USER_TEST_DB);
    try {
      await waitFor(async () => expect((await db.meta.get('activeSpaceId'))?.value).toBe('s-trip'), { timeout: 5000 });
    } finally {
      db.close();
    }
  }, 15_000);

  it('a space the person is no longer in leaves them where they were', async () => {
    await startIn('s-user');
    renderAppAsUser('/settings?space=s-left', { spaces });
    await screen.findByTestId('screen-settings', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.getByTestId('settings-space-row').textContent).toContain('Personal'), { timeout: 5000 });
    const db = new MunniDB(USER_TEST_DB);
    expect((await db.meta.get('activeSpaceId'))?.value).toBe('s-user');
    db.close();
  }, 15_000);
});
