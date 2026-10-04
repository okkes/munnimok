// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_PROTOCOL } from '@/lib/protocol';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';

/**
 * The forced update (user ruling 2026-10-04): a server that no longer
 * speaks this build takes the screen, not just the banner.
 */
describe('UpdateGate', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
  });

  it('takes the screen when the server says this build is too old, and offers the reload on the web', async () => {
    renderAppAsUser('/home', {
      api: {
        'GET /health': () => ({ capabilities: {}, protocol: CLIENT_PROTOCOL, minClientProtocol: CLIENT_PROTOCOL + 1 }),
      },
    });
    const gate = await screen.findByTestId('update-gate', {}, { timeout: 5000 });
    expect(gate.textContent).toContain('Update munni');
    expect(screen.getByTestId('update-gate-go').textContent).toBe('Reload');
  }, 15_000);

  it('stays out of the way while the handshake agrees', async () => {
    renderAppAsUser('/home');
    await screen.findByTestId('screen-home', {}, { timeout: 5000 });
    await waitFor(() => expect(screen.queryByTestId('update-gate')).toBeNull());
  }, 15_000);
});
