// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import type { NativeDelivered } from '@/lib/platform';
import { HlcClock } from '@/sync/hlc';

const native = vi.hoisted(() => ({
  delivered: null as NativeDelivered[] | null,
  removed: [] as NativeDelivered[],
}));
vi.mock('@/lib/platform', () => ({
  nativeDelivered: () => Promise.resolve(native.delivered),
  removeNativeDelivered: (list: NativeDelivered[]) => {
    native.removed.push(...list);
    return Promise.resolve();
  },
}));

import { closeShownOfScopes, closeShownWhere, scopeOfTag, shownNotifications } from './deliveredNotifications';

function installShown(shown: { close: () => void; timestamp?: number; tag?: string }[]) {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: () => Promise.resolve({ getNotifications: () => Promise.resolve(shown) }) },
  });
}

describe('what the device still shows (#614)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    native.delivered = null;
    native.removed = [];
    Reflect.deleteProperty(navigator, 'serviceWorker');
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('in a browser: the notifications the worker showed, by their tag — one without a tag is not ours to judge', async () => {
    const shown = [{ close: vi.fn(), tag: 'friend-request', timestamp: 5 }, { close: vi.fn() }];
    installShown(shown);

    expect((await shownNotifications()).map((n) => [n.tag, n.at])).toEqual([['friend-request', 5]]);
    await closeShownWhere((tag) => tag === 'friend-request');
    expect(shown[0].close).toHaveBeenCalledTimes(1);
    expect(shown[1].close).not.toHaveBeenCalled();
  });

  it('on Android: the tag the server filed the push under; one FCM named by itself is left alone', async () => {
    native.delivered = [
      { id: 7, tag: 'new-tx-s1' },
      { id: 8, tag: 'FCM-Notification:918273' },
    ];

    expect((await shownNotifications()).map((n) => n.tag)).toEqual(['new-tx-s1']);
    await closeShownWhere(() => true);
    // the phone removes by id and tag: the entry goes back as it came
    expect(native.removed).toEqual([{ id: 7, tag: 'new-tx-s1' }]);
  });

  it('on iOS: no tag, but the push’s data — the worker’s own rule names it', async () => {
    native.delivered = [
      { id: 'A1', data: { payload: JSON.stringify({ type: 'new-transactions', spaceId: 's1', count: 3 }) } },
      { id: 'A2', data: { payload: JSON.stringify({ type: 'split', kind: 'invited', splitId: 'sp1' }) } },
      { id: 'A3', data: { payload: 'not json' } },
      { id: 'A4' },
    ];

    expect((await shownNotifications()).map((n) => n.tag)).toEqual(['new-tx-s1', 'split-invited-sp1']);
    await closeShownWhere((tag) => tag === 'split-invited-sp1');
    expect(native.removed.map((n) => n.id)).toEqual(['A2']);
  });

  it('a tag says which part of the bell it belongs to', async () => {
    const store = new DexieBackend(new MunniDB(`munni_dn_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('dn'), { trackOutbox: false });
    await repo.upsert('budget', 's1', 'b1', { name: 'Groceries', amountCents: 10_000, every: 'month', anchor: '2026-11-01' });
    await repo.upsert('recurring', 's2', 'r1', { name: 'Rent', amountCents: 90_000, every: 'month', active: 1 });

    for (const tag of ['friend-request', 'space-invite', 'member-role', 'split-settled-get-sp1', 'test']) {
      expect(await scopeOfTag(store, tag)).toBe('general');
    }
    expect(await scopeOfTag(store, 'new-tx-s1')).toBe('s1');
    expect(await scopeOfTag(store, 'plan-s1-2026-11-16')).toBe('s1');
    expect(await scopeOfTag(store, 'budget-b1-2026-11-01')).toBe('s1');
    expect(await scopeOfTag(store, 'rec-remind-r1')).toBe('s2');
    // a push that named no space, and tags that name something this device does not hold
    expect(await scopeOfTag(store, 'new-tx-all')).toBeUndefined();
    expect(await scopeOfTag(store, 'budget-gone-2026-11-01')).toBeUndefined();
    expect(await scopeOfTag(store, 'debt-rate-loan1')).toBeUndefined();
  });

  it('closing the parts of the bell: their notifications and the named tags go, later arrivals stay', async () => {
    const store = new DexieBackend(new MunniDB(`munni_dn_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const shown = [
      { close: vi.fn(), tag: 'new-tx-s1', timestamp: 100 },
      { close: vi.fn(), tag: 'new-tx-s1', timestamp: 900 },
      { close: vi.fn(), tag: 'new-tx-s2', timestamp: 100 },
      { close: vi.fn(), tag: 'debt-rate-loan1', timestamp: 100 },
    ];
    installShown(shown);

    await closeShownOfScopes(store, ['s1'], new Set(['debt-rate-loan1']), 500);
    expect(shown.map((n) => n.close.mock.calls.length)).toEqual([1, 0, 0, 1]);
  });
});
