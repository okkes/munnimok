// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { defaultAccountId } from '@/domain/defaultAccounts';
import { HlcClock } from '@/sync/hlc';
import { debtsMissingRate } from './debts';

describe('debtsMissingRate', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('asks for the loans a space holds without a rate — never for a default account on its way out', async () => {
    const store = new DexieBackend(new MunniDB(`munni_debtrate_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('debtrate'), { trackOutbox: false });
    const loan = (spaceId: string, id: string, name: string, extra: object = {}) =>
      repo.upsert('account', spaceId, id, { name, type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -5_000, ...extra });
    for (const spaceId of ['s1', 's2']) await repo.upsert('space', spaceId, spaceId, { name: spaceId, kind: 'personal', currency: 'EUR' });
    await loan('s1', defaultAccountId('s1', 'debtPayment'), 'Default loan', { balanceCents: 0, defaultFor: 'debtPayment' });
    await loan('s2', defaultAccountId('s2', 'debtPayment'), 'Default loan', { defaultFor: 'debtPayment' });
    await loan('s1', 'car', 'Car loan');
    await loan('s1', 'kept', 'Kept loan', { defaultFor: null });
    await loan('s1', 'rated', 'Rated loan', { interestPctYear: 0 });

    expect((await debtsMissingRate(store)).map((a) => a.name).sort((a, b) => a.localeCompare(b))).toEqual(['Car loan', 'Kept loan']);
  });
});
