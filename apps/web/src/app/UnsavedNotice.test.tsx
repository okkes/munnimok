// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { renderApp } from '@/test/harness';

describe('the notice of changes that were undone', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase('munni_demo');
  });

  it('names the space, or the account when the changes sat in another member’s account — never an empty name', async () => {
    const db = new MunniDB('munni_demo');
    await db.meta.put({
      key: 'unsavedUndone',
      value: [
        { spaceId: 's-home', spaceName: 'Household', count: 3 },
        { spaceId: 'feed-x', spaceName: '', accountName: 'DUO', count: 1 },
        // left by the build that named nothing for a feed
        { spaceId: 'feed-y', spaceName: '', count: 2 },
      ],
    });
    db.close();
    renderApp('/home');

    const space = await screen.findByTestId('unsaved-undone-s-home', {}, { timeout: 8000 });
    expect(space.textContent).toContain('“Household”');
    expect(space.textContent).toContain('3 changes');
    const account = screen.getByTestId('unsaved-undone-feed-x');
    expect(account.textContent).toContain('“DUO”');
    expect(account.textContent).toContain('another member');
    const unnamed = screen.getByTestId('unsaved-undone-feed-y');
    expect(unnamed.textContent).not.toContain('“”');
    expect(unnamed.textContent).toContain('another member');
  }, 20_000);
});
