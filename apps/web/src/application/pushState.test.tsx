// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSession } from '@/app/session';
import { usePushState } from './pushState';
// harness registers RTL cleanup between tests
import '@/test/harness';

const push = vi.hoisted(() => ({ supported: true, enabled: false, caps: { push: true, vapidPublicKey: 'key' } as Record<string, unknown> }));

vi.mock('@/lib/push', () => ({
  pushSupported: () => push.supported,
  pushEnabled: async () => push.enabled,
}));
vi.mock('@/lib/api', () => ({
  getApiCapabilities: async () => push.caps,
}));

/** the device's mirror of the spaces switched off (#549) */
const metaStore = (off: string[] = []) => ({
  metaGet: async (key: string) => (key === 'notifyOffSpaces' ? { key, value: off } : undefined),
  metaPut: async () => undefined,
});

afterEach(() => {
  useSession.getState().logout();
  push.supported = true;
  push.enabled = false;
  push.caps = { push: true, vapidPublicKey: 'key' };
});

describe('usePushState (#534: can a warning about this space reach this device?)', () => {
  it('the demo and offline profiles have no account to push to', async () => {
    useSession.getState().login({ kind: 'demo' });
    const { result } = renderHook(() => usePushState(metaStore(), 's1'));
    await waitFor(() => expect(result.current).toBe('no-account'));
  });

  it('a signed-in device reads its own switch: on or off', async () => {
    useSession.getState().login({ kind: 'user', sub: 'u1', testAuth: true });
    const off = renderHook(() => usePushState(metaStore(), 's1'));
    await waitFor(() => expect(off.result.current).toBe('off'));
    push.enabled = true;
    const on = renderHook(() => usePushState(metaStore(), 's1'));
    await waitFor(() => expect(on.result.current).toBe('on'));
  });

  it('a space switched off (#549) reads off even on a device that receives notifications', async () => {
    useSession.getState().login({ kind: 'user', sub: 'u1', testAuth: true });
    push.enabled = true;
    const muted = renderHook(() => usePushState(metaStore(['s1']), 's1'));
    await waitFor(() => expect(muted.result.current).toBe('off'));
    const other = renderHook(() => usePushState(metaStore(['s1']), 's2'));
    await waitFor(() => expect(other.result.current).toBe('on'));
  });

  it('no switch to flip where the server or the browser offers no push', async () => {
    useSession.getState().login({ kind: 'user', sub: 'u1', testAuth: true });
    push.caps = {};
    const noServer = renderHook(() => usePushState(metaStore(), 's1'));
    await waitFor(() => expect(noServer.result.current).toBe('unsupported'));
    push.caps = { push: true, vapidPublicKey: 'key' };
    push.supported = false;
    const noBrowser = renderHook(() => usePushState(metaStore(), 's1'));
    await waitFor(() => expect(noBrowser.result.current).toBe('unsupported'));
  });
});
