// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/api';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { appendNotification, GENERAL_SCOPE, readClearedBy, readInbox, readInboxClearedAt } from './notifications';
import { clearNotifications, syncNotificationsCleared } from './inboxClear';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn() }));
const apiFetchMock = vi.mocked(apiFetch);
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const pause = () => new Promise((r) => setTimeout(r, 5));

/** the server's answer to a clear of some parts: each part at the moment it was sent */
const echoScopes = async (_path: string, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body)) as { clearedAt: string; scopes: string[] };
  return json({ clearedAt: null, scopes: Object.fromEntries(sent.scopes.map((scope) => [scope, sent.clearedAt])) });
};

function installShown(shown: { close: () => void; timestamp?: number; tag?: string }[]) {
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

  it('Clear empties what the bell showed, closes what the OS shows of it and tells the person’s other devices', async () => {
    const store = fresh();
    await appendNotification(store, 'whatsnew', { version: '5.23.0' });
    await appendNotification(store, 'digest', { n: '3', spaceId: 's1' }, 'insightDigest_2026-W47');
    await appendNotification(store, 'planOverspent', { names: 'Rent', spaceId: 's2' });
    const shown = [
      { close: vi.fn(), timestamp: Date.now(), tag: 'friend-accept' },
      { close: vi.fn(), timestamp: Date.now(), tag: 'new-tx-s1' },
      { close: vi.fn(), timestamp: Date.now(), tag: 'insightDigest_2026-W47' },
      { close: vi.fn(), timestamp: Date.now(), tag: 'new-tx-s2' },
    ];
    installShown(shown);
    apiFetchMock.mockImplementation(echoScopes);

    await clearNotifications(store, true, [GENERAL_SCOPE, 's1']);
    // #614: the space the bell did not show keeps its row and its notification
    expect((await readInbox(store)).map((e) => e.payload?.spaceId)).toEqual(['s2']);
    expect(shown.map((n) => n.close.mock.calls.length)).toEqual([1, 1, 1, 0]);
    expect(apiFetchMock).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(String(apiFetchMock.mock.calls[0][1]?.body)) as { scopes: string[] };
    expect(sent.scopes).toEqual([GENERAL_SCOPE, 's1']);
  });

  it('a clear made offline goes out with the next sync — after that the device only listens', async () => {
    const store = fresh();
    installShown([]);
    apiFetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await clearNotifications(store, true, [GENERAL_SCOPE]);

    apiFetchMock.mockImplementationOnce(echoScopes);
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

    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: elsewhere }));
    expect(await syncNotificationsCleared(store)).toBe(false);
  });

  it('the person’s own Clear empties the part even while this device’s clock is behind the remembered moment', async () => {
    const store = fresh();
    installShown([]);
    // a clear made elsewhere, stamped by a clock three minutes ahead of this device's
    const ahead = new Date(Date.now() + 3 * 60_000).toISOString();
    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: null, scopes: { s1: ahead } }));
    await syncNotificationsCleared(store);
    await appendNotification(store, 'recurringDue', { name: 'Rent', date: '12 Nov', spaceId: 's1' }, 'rec_rent');

    await clearNotifications(store, false, ['s1']);
    expect(await readInbox(store)).toEqual([]);
    // the later moment stays: going back would let the other device's older clear count as news again
    expect((await readClearedBy(store)).s1).toBe(ahead);
  });

  it('#614: a part cleared on another device takes that part’s older rows and notifications here, and nothing else', async () => {
    const store = fresh();
    await appendNotification(store, 'digest', { n: '3', spaceId: 's1' });
    await appendNotification(store, 'digest', { n: '1', spaceId: 's2' });
    const before = Date.now();
    await pause();
    const elsewhere = new Date().toISOString().replace('Z', '+00:00');
    await pause();
    const shown = [
      { close: vi.fn(), timestamp: before, tag: 'new-tx-s1' },
      { close: vi.fn(), timestamp: Date.now(), tag: 'new-tx-s1' },
      { close: vi.fn(), timestamp: before, tag: 'new-tx-s2' },
    ];
    installShown(shown);
    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: null, scopes: { s1: elsewhere } }));

    expect(await syncNotificationsCleared(store)).toBe(true);
    expect((await readInbox(store)).map((e) => e.payload?.spaceId)).toEqual(['s2']);
    expect(shown.map((n) => n.close.mock.calls.length)).toEqual([1, 0, 0]);
    expect(await readInboxClearedAt(store)).toBeUndefined();

    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: null, scopes: { s1: elsewhere } }));
    expect(await syncNotificationsCleared(store)).toBe(false);
  });

  it('a whole-list clear an older build left waiting still goes out as one', async () => {
    const store = fresh();
    installShown([]);
    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: '2026-11-01T10:00:00.000Z' }));
    await syncNotificationsCleared(store);
    await store.metaPut('notifClearPending', true);

    apiFetchMock.mockResolvedValueOnce(json({ clearedAt: '2026-11-01T10:00:00.000Z' }));
    await syncNotificationsCleared(store);
    expect(apiFetchMock).toHaveBeenLastCalledWith(
      '/me/notifications/cleared',
      expect.objectContaining({ method: 'PUT', body: JSON.stringify({ clearedAt: '2026-11-01T10:00:00.000Z' }) }),
    );
  });

  it('a profile without a server clears on this device alone', async () => {
    const store = fresh();
    installShown([]);
    await appendNotification(store, 'digest', { n: '1' });
    await clearNotifications(store, false, [GENERAL_SCOPE]);
    expect(await readInbox(store)).toEqual([]);
    expect(apiFetchMock).not.toHaveBeenCalled();
  });
});
