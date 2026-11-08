// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { predictFromMemory } from '@/domain/merchantMemory';
import { mirrorTxId } from '@/domain/feedIds';
import { buildSpaceMerchantMemory } from './prediction';

let counter = 0;
let db: MunniDB;
let repo: Repo;

describe('buildSpaceMerchantMemory (user-scoped cross-space learning)', () => {
  beforeEach(async () => {
    db = new MunniDB(`prediction_test_${++counter}`);
    repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
    await repo.upsert('space', 'sx', 'sx', { name: 'Personal X', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('space', 'sy', 'sy', { name: 'Shared Y', kind: 'shared', currency: 'EUR', periodType: 'month', periodDay: 1 });
  });

  it('a categorization in space X teaches the FALLBACK layer of space Y (#161: own space first)', async () => {
    await repo.upsert('transaction', 'sx', 'txx', {
      accountId: 'a1',
      date: '2026-07-01',
      amountCents: -2500,
      currency: 'EUR',
      merchant: 'Albert Heijn Delft',
      catId: 'movie', // deliberate odd builtin choice — must carry over
      needsReview: 0,
    });

    const memory = await buildSpaceMerchantMemory(new DexieBackend(db), 'sy');
    // branch city differs: normalization still finds the same merchant —
    // in the OTHERS layer, since sy itself never saw the merchant
    expect(predictFromMemory(memory.own, 'Albert Heijn Amsterdam', -1900)).toBeNull();
    const hit = predictFromMemory(memory.others, 'Albert Heijn Amsterdam', -1900);
    expect(hit?.catId).toBe('movie');
  });

  it("#161: the own space's history OUTRANKS other spaces for the same merchant", async () => {
    await repo.upsert('transaction', 'sx', 'txg', {
      accountId: 'a1', date: '2026-07-01', amountCents: -2500, currency: 'EUR',
      merchant: 'Albert Heijn', catId: 'movie', needsReview: 0,
    });
    await repo.upsert('transaction', 'sy', 'tyg', {
      accountId: 'a2', date: '2026-06-01', amountCents: -1800, currency: 'EUR',
      merchant: 'Albert Heijn', catId: 'groceries', needsReview: 0,
    });
    const memory = await buildSpaceMerchantMemory(new DexieBackend(db), 'sy');
    // sy's own single groceries answer wins over sx's newer movie one
    expect(predictFromMemory(memory.own, 'Albert Heijn', -2000)?.catId).toBe('groceries');
  });

  it("another space's CUSTOM category never crosses over", async () => {
    await repo.upsert('transaction', 'sx', 'txc', {
      accountId: 'a1',
      date: '2026-07-01',
      amountCents: -2500,
      currency: 'EUR',
      merchant: 'Padel Baan',
      catId: 'custom_padel_x', // not a catalog id — invisible to sy
      needsReview: 0,
    });

    const memory = await buildSpaceMerchantMemory(new DexieBackend(db), 'sy');
    expect(predictFromMemory(memory.own, 'Padel Baan', -2500)).toBeNull();
    expect(predictFromMemory(memory.others, 'Padel Baan', -2500)).toBeNull();
    // …while the owning space keeps its own history
    const own = await buildSpaceMerchantMemory(new DexieBackend(db), 'sx');
    expect(predictFromMemory(own.own, 'Padel Baan', -2500)?.catId).toBe('custom_padel_x');
  });

  it('#564: the counter leg munni minted on the savings pot never teaches — a pot\'s own rows teach its own ledger only', async () => {
    await repo.upsert('account', 'sx', 'chk', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', 'sx', 'pot', { name: 'Oranje', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    // the confirmed Set aside, and the leg the link minted on the pot under the same merchant
    await repo.upsert('transaction', 'sx', 'src', {
      accountId: 'chk', date: '2026-08-01', amountCents: -50000, currency: 'EUR',
      merchant: 'Oranje spaarrekening M10614086', catId: 'savingDeposit', needsReview: 0, transferPeerId: mirrorTxId('src'),
    });
    await repo.upsert('transaction', 'sx', mirrorTxId('src'), {
      accountId: 'pot', date: '2026-08-01', amountCents: 50000, currency: 'EUR',
      merchant: 'Oranje spaarrekening M10614086', catId: 'savingDeposit', needsReview: 0, transferPeerId: 'src',
    });
    // a row the pot's own feed carried, filed from the pot's side
    await repo.upsert('transaction', 'sx', 'potrow', {
      accountId: 'pot', date: '2026-08-02', amountCents: 20000, currency: 'EUR',
      merchant: 'Mw E Kaymazlar', catId: 'savingDeposit', needsReview: 0,
    });

    const memory = await buildSpaceMerchantMemory(new DexieBackend(db), 'sx');
    // money back FROM the pot on the checking account: nothing in the memory says Set aside
    expect(predictFromMemory(memory.own, 'Oranje spaarrekening M10614086', 50000)).toBeNull();
    expect(predictFromMemory(memory.own, 'Mw E Kaymazlar', 20000)).toBeNull();
    expect(predictFromMemory(memory.own, 'Mw E Kaymazlar', 20000, 'saving')?.catId).toBe('savingDeposit');
    // the person's own outgoing filing still teaches its side
    expect(predictFromMemory(memory.own, 'Oranje spaarrekening M10614086', -50000)?.catId).toBe('savingDeposit');
  });
});
