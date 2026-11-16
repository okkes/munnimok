// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { HlcClock } from '@/sync/hlc';
import { settleAnswered, settleReviewed } from './deliveredResolve';

type Shown = { close: ReturnType<typeof vi.fn>; tag: string };

function installShown(tags: string[]): Shown[] {
  const shown = tags.map((tag) => ({ close: vi.fn(), tag }));
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: { getRegistration: () => Promise.resolve({ getNotifications: () => Promise.resolve(shown) }) },
  });
  return shown;
}

const closed = (shown: Shown[]) => shown.filter((n) => n.close.mock.calls.length > 0).map((n) => n.tag);

describe('a handled notification leaves the device (#614)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    Reflect.deleteProperty(navigator, 'serviceWorker');
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function twoSpaces() {
    const store = new DexieBackend(new MunniDB(`munni_dr_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('dr'), { trackOutbox: false });
    for (const id of ['s1', 's2']) {
      await repo.upsert('space', id, id, { name: id, kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
      await repo.upsert('account', id, `acc-${id}`, { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 0, source: 'manual' });
    }
    const tx = (spaceId: string, id: string, needsReview: 0 | 1) =>
      repo.upsert('transaction', spaceId, id, { accountId: `acc-${spaceId}`, date: '2026-11-16', amountCents: -1_000, currency: 'EUR', merchant: 'Shop', needsReview });
    return { store, tx };
  }

  it('"new transactions arrived" goes once nothing in that space waits for review; another space’s stays', async () => {
    const { store, tx } = await twoSpaces();
    await tx('s1', 'a', 0);
    await tx('s2', 'b', 1);
    const shown = installShown(['new-tx-s1', 'new-tx-s2', 'friend-request']);

    await settleReviewed(store);
    expect(closed(shown)).toEqual(['new-tx-s1']);
  });

  it('a push that named no space waits for every space', async () => {
    const { store, tx } = await twoSpaces();
    await tx('s1', 'a', 0);
    await tx('s2', 'b', 1);
    const waiting = installShown(['new-tx-all']);
    await settleReviewed(store);
    expect(closed(waiting)).toEqual([]);

    await tx('s2', 'b', 0);
    const done = installShown(['new-tx-all']);
    await settleReviewed(store);
    expect(closed(done)).toEqual(['new-tx-all']);
  });

  it('a request or an invitation goes once the server no longer lists it; a part nobody asked about is left alone', async () => {
    const all = ['friend-request', 'space-invite', 'split-invited-sp1', 'split-invited-sp2', 'split-join-request-sp3', 'friend-accept'];

    const still = installShown(all);
    await settleAnswered({ friendRequests: 1, spaceInvites: 2, splitInvites: ['sp1', 'sp2'], splitRequests: { splitId: 'sp3', waiting: 1 } });
    expect(closed(still)).toEqual([]);

    const answered = installShown(all);
    await settleAnswered({ friendRequests: 0, spaceInvites: 0, splitInvites: ['sp2'], splitRequests: { splitId: 'sp3', waiting: 0 } });
    expect(closed(answered)).toEqual(['friend-request', 'space-invite', 'split-invited-sp1', 'split-join-request-sp3']);

    // the friends screen only knows about friend requests
    const partial = installShown(all);
    await settleAnswered({ friendRequests: 0 });
    expect(closed(partial)).toEqual(['friend-request']);
  });
});
