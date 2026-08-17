// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { changeAccountType } from './accounts';

const SPACE = 's1';

describe('#212: the destructive type change', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('re-types the account and sends its rows back to review under the new stamp', async () => {
    const store = new DexieBackend(new MunniDB(`munni_typ_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('typ'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month' });
    await repo.upsert('account', SPACE, 'a1', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 5_000, source: 'manual' });
    await repo.upsert('account', SPACE, 'other', { name: 'Other', type: 'checking', currency: 'EUR', balanceCents: 0, source: 'manual' });
    const base = { currency: 'EUR', needsReview: 0 as const };
    await repo.upsert('transaction', SPACE, 't1', { ...base, accountId: 'a1', date: '2026-02-01', amountCents: -1_500, merchant: 'AH', catId: 'groceries', txType: 'expense' });
    await repo.upsert('transaction', SPACE, 't2', { ...base, accountId: 'a1', date: '2026-02-02', amountCents: 2_000, merchant: 'Refund', catId: 'incomeOther', txType: 'income' });
    await repo.upsert('transaction', SPACE, 'keep', { ...base, accountId: 'other', date: '2026-02-03', amountCents: -900, merchant: 'X', catId: 'coffee', txType: 'expense' });

    const account = (await store.get('account', 'a1'))!;
    const touched = await changeAccountType(store, repo, account, 'savings');
    expect(touched).toBe(2);

    expect((await store.get('account', 'a1'))?.type).toBe('savings');
    // savings STAMPS its rows — every one re-reads as saving, back in review
    expect(await store.get('transaction', 't1')).toMatchObject({ catId: 'uncategorized', txType: 'saving', needsReview: 1 });
    expect(await store.get('transaction', 't2')).toMatchObject({ catId: 'uncategorized', txType: 'saving', needsReview: 1 });
    // other accounts' rows stay untouched
    expect(await store.get('transaction', 'keep')).toMatchObject({ catId: 'coffee', needsReview: 0 });
    // balances are physical facts — the type never rewrites them
    expect((await store.get('account', 'a1'))?.balanceCents).toBe(5_000);
  });

  it('an unstamped target re-derives plain types by sign', async () => {
    const store = new DexieBackend(new MunniDB(`munni_typ_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('typ2'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month' });
    await repo.upsert('account', SPACE, 'pot', { name: 'Pot', type: 'savings', currency: 'EUR', balanceCents: 0, source: 'manual' });
    await repo.upsert('transaction', SPACE, 's1r', { accountId: 'pot', date: '2026-03-01', amountCents: -4_000, currency: 'EUR', merchant: 'Out', catId: 'savingWithdraw', txType: 'saving', needsReview: 0 });

    const account = (await store.get('account', 'pot'))!;
    await changeAccountType(store, repo, account, 'checking');
    expect(await store.get('transaction', 's1r')).toMatchObject({ catId: 'uncategorized', txType: 'expense', needsReview: 1 });
  });
});
