// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { appendNotification, readInbox } from './notifications';
import { clearNotifications, syncNotificationsCleared } from './inboxClear';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const pause = () => new Promise((r) => setTimeout(r, 5));

/** the OS notifications the service worker still shows, as the browser lists them */
function installShown(shown: { close: () => void; timestamp?: number }[]) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: () => Promise.resolve({ getNotifications: () => Promise.resolve(shown) }),
    },
  });
}

describe('clearing notifications (#580)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    apiFetchMock.mockReset();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    for (const s of stores.splice(0)) await s.destroy();
  });
  const fresh = () => {
    const store = new DexieBackend(new MunniDB(`munni_ic_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    return store;
  };

  it('Clear empties the list, closes what the OS shows and tells the person’s other devices', async () => {
    const store = fresh();
    await appendNotification(store, 'digest', { n: '3' });
    const shown = [{ close: vi.fn(), timestamp: Date.now() }];
    installShown(shown);
    apiFetchMock.mockImplementation(async (_path, init) =>
      json({
        clearedAt: (JSON.parse(String(init?.body)) as { clearedAt: string }).clearedAt,
      }),
    );

    await clearNotifications(store, true);
    expect(await readInbox(store)).toEqual([]);
    expect(shown[0].close).toHaveBeenCalled();
    expect(apiFetchMock).toHaveBeenCalledWith('/me/notifications/cleared', expect.objectContaining({ method: 'PUT' }));
  });

  it('a clear made offline goes out with the next sync — after that the device only listens', async () => {
    const store = fresh();
    installShown([]);
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await clearNotifications(store, true);

    apiFetchMock.mockImplementationOnce(async (_path, init) =>
      json({
        clearedAt: (JSON.parse(String(init?.body)) as { clearedAt: string }).clearedAt,
      }),
    );
    await syncNotificationsCleared(store);
    expect(apiFetchMock).toHaveBeenLastCalledWith('/me/notifications/cleared', expect.objectContaining({ method: 'PUT' }));

    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: null }));
    expect(await syncNotificationsCleared(store)).toBe(false);
    expect(apiFetchMock).toHaveBeenLastCalledWith('/me/notifications/cleared');
  });

  it('a clear made on another device takes the older rows and OS notifications here — not what came later', async () => {
    const store = fresh();
    await appendNotification(store, 'digest', { n: '3' });
    const before = Date.now();
    await pause();
    // the server's own spelling of the moment
    const elsewhere = new Date().toISOString().replace('Z', '+00:00');
    await pause();
    await appendNotification(store, 'debtRate', { name: 'Car loan' });
    const shown = [
      { close: vi.fn(), timestamp: before },
      { close: vi.fn(), timestamp: Date.now() },
    ];
    installShown(shown);
    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: elsewhere }));

    expect(await syncNotificationsCleared(store)).toBe(true);
    expect((await readInbox(store)).map((e) => e.kind)).toEqual(['debtRate']);
    expect(shown[0].close).toHaveBeenCalled();
    expect(shown[1].close).not.toHaveBeenCalled();

    // the same moment again is old news
    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: elsewhere }));
    expect(await syncNotificationsCleared(store)).toBe(false);
  });

  it('a profile without a server clears on this device alone', async () => {
    const store = fresh();
    installShown([]);
    await appendNotification(store, 'digest', { n: '1' });
    await clearNotifications(store, false);
    expect(await readInbox(store)).toEqual([]);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
