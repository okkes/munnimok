// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { osNotifyAllowed, readSpacesNotifyOff, refreshSpacesNotifyOff, setSpaceNotify, spaceNotifyOn } from './spaceNotifications';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('notifications chosen per space (#549)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    apiFetchMock.mockReset();
    for (const s of stores.splice(0)) await s.destroy();
  });
  const fresh = () => {
    const store = new DexieBackend(new MunniDB(`munni_sn_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    return store;
  };

  it('a space notifies unless it was switched off — the server’s list is this device’s mirror', async () => {
    const store = fresh();
    expect(await spaceNotifyOn(store, 's1')).toBe(true);

    apiFetchMock.mockResolvedValueOnce(json({ off: ['s1', 42] }));
    expect(await refreshSpacesNotifyOff(store)).toEqual(['s1']);
    expect(await spaceNotifyOn(store, 's1')).toBe(false);
    expect(await spaceNotifyOn(store, 's2')).toBe(true);

    // the server out of reach: the mirror keeps what it knew
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    expect(await refreshSpacesNotifyOff(store)).toBeNull();
    expect(await readSpacesNotifyOff(store)).toEqual(['s1']);
  });

  it('a switch counts once the server took it — a refused one changes nothing here', async () => {
    const store = fresh();
    apiFetchMock.mockResolvedValueOnce(json({ spaceId: 's1', on: false }));
    expect(await setSpaceNotify(store, 's1', false)).toBe(true);
    expect(apiFetchMock).toHaveBeenCalledWith(
      '/me/space-notifications/s1',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ on: false }),
      }),
    );
    expect(await spaceNotifyOn(store, 's1')).toBe(false);

    apiFetchMock.mockResolvedValueOnce(json({}, 500));
    expect(await setSpaceNotify(store, 's1', true)).toBe(false);
    expect(await spaceNotifyOn(store, 's1')).toBe(false);

    apiFetchMock.mockResolvedValueOnce(json({ spaceId: 's1', on: true }));
    expect(await setSpaceNotify(store, 's1', true)).toBe(true);
    expect(await spaceNotifyOn(store, 's1')).toBe(true);
  });

  it('the device shows its own alerts only with permission, and only for spaces switched on', async () => {
    const store = fresh();
    try {
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: { permission: 'default' },
      });
      expect(await osNotifyAllowed(store, 's1')).toBe(false);
      Object.defineProperty(window, 'Notification', {
        configurable: true,
        value: { permission: 'granted' },
      });
      expect(await osNotifyAllowed(store, 's1')).toBe(true);
      await store.metaPut('notifyOffSpaces', ['s1']);
      expect(await osNotifyAllowed(store, 's1')).toBe(false);
      expect(await osNotifyAllowed(store, 's2')).toBe(true);
    } finally {
      Reflect.deleteProperty(window, 'Notification');
    }
  });
});
