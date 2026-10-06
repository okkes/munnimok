// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { USER_TEST_DB, renderAppAsUser } from '@/test/harness';
import { MunniDB } from '@/db/schema';
import { resolveOfflineReason, syncPillFace } from './OfflineBanner';

/** one write waiting in the test user's outbox */
async function leaveAPendingWrite(opId: string) {
  const db = new MunniDB(USER_TEST_DB);
  await db.outbox.add({ opId, spaceId: 's1', entity: 'transaction', entityId: 't1', fields: { notes: 'x' }, hlc: '000000000001-0000-test' });
  db.close();
}

describe('resolveOfflineReason', () => {
  it('is silent for local-only identities (no engine) — offline mode is a choice', () => {
    expect(resolveOfflineReason(false, false, 'offline')).toBeNull();
    expect(resolveOfflineReason(false, true, 'error')).toBeNull();
  });

  it('reports no-network the moment connectivity is gone, before sync fails', () => {
    expect(resolveOfflineReason(true, false, 'idle')).toBe('no-network');
    expect(resolveOfflineReason(true, false, 'error')).toBe('no-network');
  });

  it('reports unreachable when the network is up but sync cannot reach the server', () => {
    expect(resolveOfflineReason(true, true, 'offline')).toBe('unreachable');
    expect(resolveOfflineReason(true, true, 'error')).toBe('unreachable');
  });

  it('stays hidden while syncing works', () => {
    expect(resolveOfflineReason(true, true, 'idle')).toBeNull();
    expect(resolveOfflineReason(true, true, 'syncing')).toBeNull();
  });

  it('a version mismatch outranks everything — the server IS reachable, sync is refused', () => {
    expect(resolveOfflineReason(true, true, 'error', 'client-outdated')).toBe('client-outdated');
    expect(resolveOfflineReason(true, false, 'error', 'server-outdated')).toBe('server-outdated');
    expect(resolveOfflineReason(false, true, 'error', 'client-outdated')).toBeNull(); // still silent without an engine
  });

  it('#222: a spent session outranks even that — "unreachable" sent users chasing the wrong problem', () => {
    expect(resolveOfflineReason(true, true, 'error', null, true)).toBe('session-expired');
    expect(resolveOfflineReason(true, true, 'idle', 'client-outdated', true)).toBe('session-expired');
    expect(resolveOfflineReason(true, false, 'offline', null, true)).toBe('session-expired');
    expect(resolveOfflineReason(false, true, 'error', null, true)).toBeNull(); // still silent without an engine
  });
});

describe('offline banner + home indicator', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    indexedDB.deleteDatabase(USER_TEST_DB);
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  });

  it('dismiss hides the banner for the session; the home pill stays', async () => {
    renderAppAsUser('/home');
    await screen.findByTestId('screen-home');

    const banner = await screen.findByTestId('offline-banner');
    expect(banner.getAttribute('data-reason')).toBe('no-network');
    expect(screen.getByTestId('home-offline-indicator')).toBeTruthy();

    fireEvent.click(screen.getByTestId('offline-banner-dismiss'));
    expect(screen.queryByTestId('offline-banner')).toBeNull();
    // the quiet indicator is the persistent signal after dismissal
    expect(screen.getByTestId('home-offline-indicator')).toBeTruthy();
    expect(sessionStorage.getItem('munni_offline_banner_dismissed')).toBe('1');
  });

  it('the pill counts the changes still waiting on this device, and Settings says when they go out (user 2026-10-06)', async () => {
    renderAppAsUser('/home');
    await screen.findByTestId('screen-home');
    await screen.findByTestId('home-offline-indicator');
    await leaveAPendingWrite('op-pending-1');
    await waitFor(() => expect(screen.getByTestId('home-offline-indicator').textContent).toContain('1 to sync'));
    expect(screen.getByTestId('home-offline-indicator').textContent).toContain('Offline');
    expect(screen.getByTestId('home-offline-indicator').getAttribute('data-pending')).toBe('1');
    // the pill opens Settings, whose sync row spells it out
    fireEvent.click(screen.getByTestId('home-offline-indicator'));
    await screen.findByTestId('settings-sync-row');
    await waitFor(() => expect(screen.getByTestId('settings-sync-pending').textContent).toContain('not synced yet: 1'));
  }, 15_000);

  it('online with nothing waiting the pill is gone; with a write waiting it counts it', async () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    renderAppAsUser('/home');
    await screen.findByTestId('screen-home');
    expect(screen.queryByTestId('home-sync-indicator')).toBeNull();
    expect(screen.queryByTestId('home-offline-indicator')).toBeNull();
    await leaveAPendingWrite('op-pending-2');
    const pill = await screen.findByTestId('home-sync-indicator');
    expect(pill.getAttribute('data-pending')).toBe('1');
  }, 15_000);

  it('the pill face: the reason outranks the count, syncing says so, a count alone says how many wait', () => {
    const t = (key: string, vars?: Record<string, string | number>) => (vars ? `${key} ${vars.n}` : key);
    expect(syncPillFace(null, 0, 'idle', t)).toBeNull();
    expect(syncPillFace(null, 3, 'idle', t)).toEqual({ icon: 'cloud-upload-outline', text: 'sync.pendingShort 3' });
    expect(syncPillFace(null, 3, 'syncing', t)).toEqual({ icon: 'cloud-sync-outline', text: 'sync.syncing' });
    expect(syncPillFace('no-network', 2, 'idle', t)).toEqual({ icon: 'wifi-off', text: 'sync.offlineShort · sync.pendingShort 2' });
    expect(syncPillFace('no-network', 0, 'idle', t)).toEqual({ icon: 'wifi-off', text: 'sync.offlineShort' });
    expect(syncPillFace('session-expired', 2, 'idle', t)).toEqual({ icon: 'account-lock-outline', text: 'sync.signInAgain' });
  });

  it('stays dismissed on remount within the same session', async () => {
    sessionStorage.setItem('munni_offline_banner_dismissed', '1');
    renderAppAsUser('/home');
    await screen.findByTestId('screen-home');
    expect(await screen.findByTestId('home-offline-indicator')).toBeTruthy();
    expect(screen.queryByTestId('offline-banner')).toBeNull();
  });

  it('#222: an expired session says so and offers sign-in — never "unreachable"', async () => {
    const { markSessionExpired, resetSessionExpiryForTests } = await import('./sessionExpiry');
    resetSessionExpiryForTests();
    markSessionExpired();
    try {
      renderAppAsUser('/home');
      await screen.findByTestId('screen-home');
      const banner = await screen.findByTestId('offline-banner');
      // beforeEach forces onLine=false: the expired verdict still outranks
      expect(banner.getAttribute('data-reason')).toBe('session-expired');
      expect(banner.textContent).toContain('session has expired');
      expect(screen.getByTestId('offline-banner-signin')).toBeTruthy();
    } finally {
      resetSessionExpiryForTests();
    }
  });
});
