// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

/**
 * Local-first startup: a RETURNING device (local spaces exist) must render
 * from its database immediately — a hanging server/OIDC endpoint may not
 * hold users on the connecting screen (field bug: app stuck on
 * "Connecting to your account" until the NAS came back, despite months of
 * local data).
 */
describe('DataProvider startup (local-first)', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('renders the app from local data while every server request hangs forever', async () => {
    // returning device: the identity db already holds a space
    const db = new MunniDB(USER_TEST_DB);
    const repo = new Repo(db, new HlcClock('seed'), { trackOutbox: false });
    await repo.upsert('space', 's-local', 's-local', {
      name: 'Mine',
      kind: 'personal',
      currency: 'EUR',
      periodType: 'month',
      periodDay: 1,
    });
    db.close();

    const hang = () => new Promise<never>(() => undefined); // never settles
    renderAppAsUser('/', {
      api: {
        'GET /health': hang,
        'GET /me/spaces': hang,
        'GET /me': hang,
      },
    });

    // the Home screen appears despite zero completed requests
    expect(await screen.findByTestId('screen-home', {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByTestId('data-loading')).toBeNull();
  });

  it('a brand-new device (no local data) keeps waiting on the connecting screen', async () => {
    const hang = () => new Promise<never>(() => undefined);
    renderAppAsUser('/', {
      api: {
        'GET /health': hang,
        'GET /me/spaces': hang,
        'GET /me': hang,
      },
    });

    expect(await screen.findByTestId('data-loading', {}, { timeout: 2000 })).toBeTruthy();
    expect(screen.queryByTestId('screen-home')).toBeNull();
  });
});
