// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { writeTxTransform } from '@/db/joined';
import { mirrorTxId } from '@/domain/feedIds';
import { HlcClock } from '@/sync/hlc';
import { cashWalletId, defaultAccountId, ensureCashWallet, retireDefaultAccounts } from './defaultAccounts';

const SPACE = 's1';

describe('#546: the retired family defaults leave their spaces', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function fresh() {
    const store = new DexieBackend(new MunniDB(`munni_retire_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('retire'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    return { store, repo };
  }

  /** a default as #221 minted it */
  const mintOld = (repo: Repo, family: 'saving' | 'debtPayment' | 'transfer', name: string, type: 'savings' | 'loan' | 'checking') =>
    repo.upsert('account', SPACE, defaultAccountId(SPACE, family), {
      name, type, source: 'manual', currency: 'EUR', balanceCents: 0, defaultFor: family,
    });

  it('an untouched default goes: its rows keep their category and return to the review, its legs and links go with it', async () => {
    const { store, repo } = await fresh();
    await mintOld(repo, 'saving', 'Default savings', 'savings');
    const pot = defaultAccountId(SPACE, 'saving');
    await repo.upsert('transaction', SPACE, 'aside1', {
      accountId: 'main', date: '2026-07-01', amountCents: -5000, currency: 'EUR', merchant: 'Set aside', catId: 'savingDeposit', needsReview: 0,
    });
    // the old fold linked it onto the default — the leg carried the money there
    await writeTxTransform(repo, { id: 'aside1', spaceId: SPACE, feedSpaceId: undefined, needsReview: 0 }, { linkedAccountId: pot });
    expect((await store.get('transaction', mirrorTxId('aside1')))?.accountId).toBe(pot);
    await repo.upsert('recurring', SPACE, 'rec1', { name: 'Monthly aside', catId: 'savingDeposit', amountCents: -5000, every: 'month', dueDay: 1, active: 1, linkedAccountId: pot });
    await repo.upsert('space', SPACE, SPACE, { goalPoolAccountIds: [pot, 'main'] });
    // the cash wallet is the default that stays
    await ensureCashWallet(store, repo, SPACE);

    expect(await retireDefaultAccounts(store, repo)).toBe(1);

    expect((await store.get('account', pot))?.deleted).toBe(1);
    const aside = await store.get('transaction', 'aside1');
    expect(aside).toMatchObject({ catId: 'savingDeposit', needsReview: 1 });
    expect(aside?.linkedAccountId ?? undefined).toBeUndefined();
    expect((await store.get('transaction', mirrorTxId('aside1')))?.deleted).toBe(1);
    expect((await store.get('recurring', 'rec1'))?.linkedAccountId ?? undefined).toBeUndefined();
    expect((await store.get('space', SPACE))?.goalPoolAccountIds).toEqual(['main']);
    expect((await store.get('account', cashWalletId(SPACE)))?.deleted).toBe(0);
    // every boot: nothing left to retire
    expect(await retireDefaultAccounts(store, repo)).toBe(0);
  });

  it('a default the person made their own stays as an ordinary account — renamed, or holding a balance they typed', async () => {
    const { store, repo } = await fresh();
    await mintOld(repo, 'saving', 'ASN savings', 'savings');
    await mintOld(repo, 'debtPayment', 'Default loan', 'loan');
    const loan = defaultAccountId(SPACE, 'debtPayment');
    // a typed balance left its adjustment row on the loan
    await repo.upsert('transaction', SPACE, 'adj1', {
      accountId: loan, date: '2026-08-01', amountCents: -120_000, currency: 'EUR', merchant: 'Balance adjustment', catId: 'balanceAdjustment', adjustment: 1, needsReview: 0,
    });
    await mintOld(repo, 'transfer', 'Default bank account', 'checking');

    expect(await retireDefaultAccounts(store, repo)).toBe(3);

    const renamed = await store.get('account', defaultAccountId(SPACE, 'saving'));
    expect(renamed).toMatchObject({ deleted: 0, name: 'ASN savings' });
    expect(renamed?.defaultFor ?? undefined).toBeUndefined();
    const kept = await store.get('account', loan);
    expect(kept?.deleted).toBe(0);
    expect(kept?.defaultFor ?? undefined).toBeUndefined();
    expect((await store.get('transaction', 'adj1'))?.deleted).toBe(0);
    expect((await store.get('account', defaultAccountId(SPACE, 'transfer')))?.deleted).toBe(1);
    expect(await retireDefaultAccounts(store, repo)).toBe(0);
  });
});
