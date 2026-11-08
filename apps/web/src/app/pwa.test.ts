// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

let registered: { onNeedRefresh?: () => void } | null = null;
const updateSpy = vi.fn();

// aliased to the stub in vitest.config; mocked here for observability
vi.mock('virtual:pwa-register', () => ({
  registerSW: vi.fn((options: { onNeedRefresh?: () => void }) => {
    registered = options;
    return updateSpy;
  }),
}));

import { handleWorkerMessage, initPwa, notificationHref, usePwa } from './pwa';
import { router } from '@/app/router';
import { useSession } from './session';

describe('handleWorkerMessage (notification deep-link)', () => {
  beforeEach(() => {
    // the app route guard bounces signed-out sessions to /login
    useSession.getState().login({ kind: 'demo' });
  });

  it('routes whitelisted hash targets posted by the worker', async () => {
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/friends' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/friends'));
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/spaces' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/spaces'));
    // budget alerts land on their detail screen
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/budgets/b42' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/budgets/b42'));
  });

  it('a new-transactions tap lands in the announced space review (#132)', async () => {
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/review?space=sp42', spaceId: 'sp42' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/review'));
    expect(router.state.location.search).toMatchObject({ space: 'sp42' });
    // cold-start shape: the space rides only the url's hash query
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/spaces' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/spaces'));
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/review?space=sp99' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/review'));
    expect(router.state.location.search).toMatchObject({ space: 'sp99' });
  });

  it('#551: every screen a notification names opens in the space it is about', async () => {
    const opens = async (url: string, path: string, space?: string) => {
      handleWorkerMessage({ type: 'NAVIGATE', url });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe(path));
      expect((router.state.location.search as { space?: string }).space).toBe(space);
    };
    await opens('./#/planning?space=sp1', '/planning', 'sp1');
    await opens('./#/recurring?space=sp2', '/recurring', 'sp2');
    await opens('./#/debts?space=sp3', '/debts', 'sp3');
    await opens('./#/insights?space=sp4', '/insights', 'sp4');
    await opens('./#/settings?space=sp5', '/settings', 'sp5');
    await opens('./#/budgets/b42?space=sp6', '/budgets/b42', 'sp6');
    await opens('./#/spaces/sp7/members', '/spaces/sp7/members');
  });

  it('notificationHref keeps to the whitelist and to id-shaped spaces', () => {
    expect(notificationHref('./#/planning?space=sp1')).toBe('/planning?space=sp1');
    // the worker's message names the space on the warm path
    expect(notificationHref('./#/review', 'sp9')).toBe('/review?space=sp9');
    expect(notificationHref('./#/review?space=..%2Fx')).toBe('/review');
    expect(notificationHref('./#/budgets/new')).toBeNull();
    expect(notificationHref('./#/settings/global')).toBeNull();
    expect(notificationHref('./#/spaces/a b/members')).toBeNull();
  });

  it('re-broadcasts worker PUSH messages as a window event', () => {
    const seen = vi.fn();
    window.addEventListener('munni-push', seen);
    handleWorkerMessage({ type: 'PUSH', payloadType: 'friend-request' });
    expect(seen).toHaveBeenCalledTimes(1);
    window.removeEventListener('munni-push', seen);
  });

  it('ignores junk, foreign message types, and off-whitelist routes', async () => {
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/spaces' });
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/spaces'));

    handleWorkerMessage(undefined);
    handleWorkerMessage('NAVIGATE');
    handleWorkerMessage({ type: 'SKIP_WAITING' });
    handleWorkerMessage({ type: 'NAVIGATE' }); // no url
    handleWorkerMessage({ type: 'NAVIGATE', url: './#/settings/global' }); // not a notification target
    handleWorkerMessage({ type: 'NAVIGATE', url: 'https://evil.example/#/friends/../../x' });

    // nothing above may have moved the router
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(router.state.location.pathname).toBe('/spaces');
  });
});

describe('pwa update store', () => {
  beforeEach(() => {
    usePwa.setState({ needRefresh: false, update: () => undefined });
    registered = null;
    updateSpy.mockClear();
  });

  it('starts idle; dismiss clears the flag', () => {
    expect(usePwa.getState().needRefresh).toBe(false);
    usePwa.setState({ needRefresh: true });
    usePwa.getState().dismiss();
    expect(usePwa.getState().needRefresh).toBe(false);
  });

  it('service-worker refresh signal raises the flag and wires update()', () => {
    initPwa();
    expect(registered).toBeTruthy();
    registered!.onNeedRefresh!();
    expect(usePwa.getState().needRefresh).toBe(true);
    usePwa.getState().update();
    expect(updateSpy).toHaveBeenCalledWith(true);
  });
});

describe('the phone app opens a tapped notification (#551)', () => {
  it('routes the tap to its screen in its space — the shell has no service worker, the taps still listen', async () => {
    useSession.getState().login({ kind: 'demo' });
    const listeners: Record<string, (data: unknown) => void> = {};
    (globalThis as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: { PushNotifications: { addListener: (event: string, cb: (data: unknown) => void) => (listeners[event] = cb) } },
    };
    try {
      registered = null;
      initPwa();
      expect(registered).toBeNull(); // no service worker in the shell
      listeners.pushNotificationActionPerformed({
        notification: { data: { payload: JSON.stringify({ type: 'new-transactions', spaceId: 'sp5', spaceName: 'Home', count: 2 }) } },
      });
      await vi.waitFor(() => expect(router.state.location.pathname).toBe('/review'));
      expect(router.state.location.search).toMatchObject({ space: 'sp5' });
    } finally {
      delete (globalThis as { Capacitor?: unknown }).Capacitor;
    }
  });
});
