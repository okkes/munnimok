// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { recurringDismissId } from '@/domain/feedIds';
import { merchantKeyBefore578 } from '@/domain/merchantKey';
import { rekeyMerchantKeys } from './merchantKeyRekey';

const SPACE = 'sp1';
const AH = 'Albert Heijn 1842 >S-GRAVENH30.10.2026 1';

describe('#578: stored merchant keys follow the new spelling once', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function seed() {
    const store = new DexieBackend(new MunniDB(`munni_rekey_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('rekey'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month' });
    const base = { accountId: 'a', currency: 'EUR', needsReview: 0 as const, catId: 'groceries' };
    await repo.upsert('transaction', SPACE, 't1', { ...base, date: '2026-10-30', amountCents: -1309, merchant: AH });
    await repo.upsert('transaction', SPACE, 't2', { ...base, date: '2026-11-02', amountCents: -880, merchant: 'Albert Heijn 1842 >S-GRAVENH02.11.2026 2' });
    await repo.upsert('transaction', SPACE, 't3', { ...base, date: '2026-10-01', amountCents: -1999, merchant: 'Netflix' });
    return { store, repo };
  }

  it('moves a recurring, a loan and a dismissal onto the key their transactions carry today — and only once', async () => {
    const { store, repo } = await seed();
    const oldKey = merchantKeyBefore578(AH);
    expect(oldKey).not.toBe('albert heijn');
    await repo.upsert('recurring', SPACE, 'rec1', { name: 'Groceries', amountCents: 1309, every: 'month', active: 1, merchantKey: oldKey });
    await repo.upsert('recurring', SPACE, 'rec2', { name: 'Netflix', amountCents: 1999, every: 'month', active: 1, merchantKey: 'netflix' });
    await repo.upsert('account', SPACE, 'loan1', { name: 'Loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -5000, merchantKey: oldKey });
    await repo.upsert('recurringDismiss', SPACE, recurringDismissId(SPACE, `${oldKey}@1309`), { merchantKey: `${oldKey}@1309` });

    expect(await rekeyMerchantKeys(store, repo)).toBe(3);
    expect((await store.get('recurring', 'rec1'))?.merchantKey).toBe('albert heijn');
    expect((await store.get('recurring', 'rec2'))?.merchantKey).toBe('netflix'); // already today's spelling
    expect((await store.get('account', 'loan1'))?.merchantKey).toBe('albert heijn');
    const dismissals = (await store.allRows('recurringDismiss')).filter((d) => d.deleted === 0);
    expect(dismissals.map((d) => d.merchantKey)).toEqual(['albert heijn@1309']);
    expect(dismissals[0].id).toBe(recurringDismissId(SPACE, 'albert heijn@1309'));

    // a later boot leaves whatever was stored since alone
    await repo.upsert('recurring', SPACE, 'rec1', { merchantKey: oldKey });
    expect(await rekeyMerchantKeys(store, repo)).toBe(0);
    expect((await store.get('recurring', 'rec1'))?.merchantKey).toBe(oldKey);
  });

  it('a key no transaction carries any more is re-read on its own', async () => {
    const { store, repo } = await seed();
    await repo.upsert('recurring', SPACE, 'gone', { name: 'Gone', amountCents: 500, every: 'month', active: 1, merchantKey: 'kiosk 7' });
    expect(await rekeyMerchantKeys(store, repo)).toBe(1);
    expect((await store.get('recurring', 'gone'))?.merchantKey).toBe('kiosk');
  });
});
