import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { accountLinkId } from '@/domain/feedIds';
import { detachFeedFromSpace, reconcileSpaceLinks } from './accountAttach';
import { fetchSpaceLinks } from '@/features/accounts/feedGateway';

vi.mock('@/features/accounts/feedGateway', () => ({
  fetchSpaceLinks: vi.fn(async () => []),
  attachAccount: vi.fn(),
  detachAccount: vi.fn(),
}));

const SPACE = 'sp1';

describe('reconcileSpaceLinks', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
    vi.mocked(fetchSpaceLinks).mockReset();
    vi.mocked(fetchSpaceLinks).mockResolvedValue([]);
  });

  async function makeStore() {
    const store = new DexieBackend(new MunniDB(`munni_rsl_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('rsl'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', historyStartDate: '2026-01-01' });
    return { store, repo };
  }

  it('mirrors server links no device ever wrote (the anonymous bank-connect completion)', async () => {
    const { store, repo } = await makeStore();
    vi.mocked(fetchSpaceLinks).mockResolvedValue([
      { id: 'srv1', feedSpaceId: 'feedA', accountId: 'accA', historyFrom: '2026-02-01', type: 'savings' },
      { id: 'srv2', feedSpaceId: 'feedB', accountId: 'accB', historyFrom: '2026-01-01', type: 'checking' },
    ]);

    expect(await reconcileSpaceLinks(store, repo, SPACE)).toBe(2);
    const mirrors = (await store.bySpace('accountLink', SPACE)).filter((l) => l.deleted === 0);
    expect(mirrors).toHaveLength(2);
    const a = mirrors.find((l) => l.feedSpaceId === 'feedA');
    expect(a?.accountId).toBe('accA');
    // the SERVER link's own gate and type seed the mirror
    expect(a?.historyFrom).toBe('2026-02-01');
    expect(a?.type).toBe('savings');
  });

  it('existing mirrors are left alone — the pass is idempotent', async () => {
    const { store, repo } = await makeStore();
    await repo.upsert('accountLink', SPACE, accountLinkId(SPACE, 'feedA'), {
      feedSpaceId: 'feedA',
      accountId: 'accA',
      historyFrom: '2025-06-01',
      archived: 0,
    });
    vi.mocked(fetchSpaceLinks).mockResolvedValue([{ id: 'srv1', feedSpaceId: 'feedA', accountId: 'accA', historyFrom: '2026-01-01', type: 'checking' }]);

    expect(await reconcileSpaceLinks(store, repo, SPACE)).toBe(0);
    const mirrors = (await store.bySpace('accountLink', SPACE)).filter((l) => l.deleted === 0);
    expect(mirrors).toHaveLength(1);
    expect(mirrors[0].historyFrom).toBe('2025-06-01'); // untouched
  });

  it('an empty server answer changes nothing', async () => {
    const { store, repo } = await makeStore();
    expect(await reconcileSpaceLinks(store, repo, SPACE)).toBe(0);
    expect((await store.bySpace('accountLink', SPACE)).filter((l) => l.deleted === 0)).toHaveLength(0);
  });

  it('#547 (user 2026-11-11): detaching an account takes the entries typed on it in this space — and nothing else', async () => {
    const { store, repo } = await makeStore();
    await repo.upsert('account', 'feedA', 'accA', { name: 'Bank', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', SPACE, 'wallet', { name: 'Wallet', type: 'cash', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('accountLink', SPACE, accountLinkId(SPACE, 'feedA'), { feedSpaceId: 'feedA', accountId: 'accA', archived: 0 });
    const row = { date: '2026-11-10', amountCents: -500, currency: 'EUR', merchant: 'x', needsReview: 0 as const };
    await repo.upsert('transaction', SPACE, 'entry', { ...row, accountId: 'accA', enteredAt: '2026-11-10T09:00:00.000Z', inBalance: 1 });
    await repo.upsert('transaction', SPACE, 'cash', { ...row, accountId: 'wallet' });
    await repo.upsert('transaction', 'feedA', 'bank', { ...row, accountId: 'accA' });

    await detachFeedFromSpace(store, repo, SPACE, 'feedA', 'accA');
    expect((await store.get('transaction', 'entry'))?.deleted).toBe(1);
    expect((await store.get('transaction', 'cash'))?.deleted).toBe(0);
    // the bank's own row is the feed's: every other space that attaches the account still has it
    expect((await store.get('transaction', 'bank'))?.deleted).toBe(0);
    expect((await store.bySpace('accountLink', SPACE)).filter((l) => l.deleted === 0)).toHaveLength(0);
  });
});
