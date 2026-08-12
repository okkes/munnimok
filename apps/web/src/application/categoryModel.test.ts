// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { defaultAccountId, ensureDefaultAccount } from './defaultAccounts';
import { migrateBareSpecialRows } from './categoryModel';

const SPACE = 's1';

describe('#133 step A: default accounts + the bare-row migration', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  function fresh() {
    const store = new DexieBackend(new MunniDB(`munni_catmodel_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('catmodel'), { trackOutbox: false });
    return { store, repo };
  }

  it('mints the default pot lazily, deterministically and idempotently', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    const id = await ensureDefaultAccount(store, repo, SPACE, 'saving');
    expect(id).toBe(defaultAccountId(SPACE, 'saving'));
    const minted = await store.get('account', id);
    expect(minted).toMatchObject({ type: 'savings', source: 'manual', defaultFor: 'saving', balanceCents: 0, currency: 'EUR' });
    // second call returns the same pot without re-minting
    expect(await ensureDefaultAccount(store, repo, SPACE, 'saving')).toBe(id);
  });

  it('links bare movement rows onto the default pot — type kept, mirror minted; value stories untouched', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    await repo.upsert('account', SPACE, 'pot', { name: 'Holiday pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    // the bare set-aside: ◆ movement category, no counterparty
    await repo.upsert('transaction', SPACE, 'bare1', {
      accountId: 'main', date: '2026-07-01', amountCents: -5000, currency: 'EUR',
      merchant: 'Set aside', catId: 'savingDeposit', txType: 'saving', needsReview: 0,
    });
    // interest is a value story, not a movement — never links
    await repo.upsert('transaction', SPACE, 'interest1', {
      accountId: 'main', date: '2026-07-02', amountCents: 300, currency: 'EUR',
      merchant: 'Interest', catId: 'savingInterest', txType: 'income', needsReview: 0,
    });
    // rows ON a special account are the pot's own ledger — untouched
    await repo.upsert('transaction', SPACE, 'onpot1', {
      accountId: 'pot', date: '2026-07-03', amountCents: 2000, currency: 'EUR',
      merchant: 'Deposit', catId: 'savingDeposit', txType: 'saving', needsReview: 0,
    });

    const touched = await migrateBareSpecialRows(store, repo);
    expect(touched).toBe(1);

    const migrated = await store.get('transaction', 'bare1');
    expect(migrated?.linkedAccountId).toBe(defaultAccountId(SPACE, 'saving'));
    // the counterparty rule: a DEFAULT pot keeps the special category's type
    expect(migrated?.txType).toBe('saving');
    expect(migrated?.transferPeerId).toBeTruthy();
    // the pot's leg exists and carries the money
    const mirror = await store.get('transaction', migrated!.transferPeerId!);
    expect(mirror).toMatchObject({ accountId: defaultAccountId(SPACE, 'saving'), amountCents: 5000 });

    expect((await store.get('transaction', 'interest1'))?.linkedAccountId).toBeUndefined();
    expect((await store.get('transaction', 'onpot1'))?.linkedAccountId).toBeUndefined();
    // #221: no marker — the fold runs every boot; idempotence comes from
    // the rows being linked now
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('#221: bare transfer-family rows link too — the ATM pair onto the CASH wallet, plain transfer onto the bank default', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    // the screenshot case: munni predicted Cash Withdraw, no counterparty
    await repo.upsert('transaction', SPACE, 'atm1', {
      accountId: 'main', date: '2026-07-10', amountCents: -100, currency: 'EUR',
      merchant: 'Geldmaat', catId: 'cashWithdraw', txType: 'transfer', needsReview: 1,
    });
    await repo.upsert('transaction', SPACE, 'tout1', {
      accountId: 'main', date: '2026-07-11', amountCents: -2500, currency: 'EUR',
      merchant: 'Moved out', catId: 'transferOut', txType: 'transfer', needsReview: 0,
    });
    await repo.upsert('transaction', SPACE, 'fund1', {
      accountId: 'main', date: '2026-07-12', amountCents: -4000, currency: 'EUR',
      merchant: 'To the pot', catId: 'fundingOut', txType: 'funding', needsReview: 0,
    });

    expect(await migrateBareSpecialRows(store, repo)).toBe(3);

    const atm = await store.get('transaction', 'atm1');
    expect(atm?.linkedAccountId).toBe(defaultAccountId(SPACE, 'cash'));
    expect(atm?.needsReview).toBe(1); // healing is not reviewing
    // the wallet's leg files by ITS counter's kind (the checking source)
    const atmMirror = await store.get('transaction', atm!.transferPeerId!);
    expect(atmMirror).toMatchObject({ accountId: defaultAccountId(SPACE, 'cash'), amountCents: 100, catId: 'transferIn' });
    // the wallet's balance moved with the leg
    expect((await store.get('account', defaultAccountId(SPACE, 'cash')))?.balanceCents).toBe(100);

    expect((await store.get('transaction', 'tout1'))?.linkedAccountId).toBe(defaultAccountId(SPACE, 'transfer'));
    // funding links its pot but mints NOTHING (#152: funding shows no rows)
    const fund = await store.get('transaction', 'fund1');
    expect(fund?.linkedAccountId).toBe(defaultAccountId(SPACE, 'funding'));
    expect(fund?.transferPeerId).toBeUndefined();

    // every-boot idempotence: nothing left to do
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('#221: ensureSpaceDefaultAccounts mints all six, once', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    const { ensureSpaceDefaultAccounts } = await import('./defaultAccounts');
    await ensureSpaceDefaultAccounts(store, repo, SPACE);
    await ensureSpaceDefaultAccounts(store, repo, SPACE); // idempotent
    const defaults = (await store.bySpace('account', SPACE)).filter((a) => a.deleted === 0 && a.defaultFor);
    expect(defaults).toHaveLength(6);
    const byFamily = new Map(defaults.map((a) => [a.defaultFor, a.type]));
    expect(byFamily.get('saving')).toBe('savings');
    expect(byFamily.get('debtPayment')).toBe('loan');
    expect(byFamily.get('investment')).toBe('brokerage');
    expect(byFamily.get('transfer')).toBe('checking');
    expect(byFamily.get('cash')).toBe('cash');
    expect(byFamily.get('funding')).toBe('funding');
  });

  it('migrates bare movement PARTS of a split through the part-mirror machinery', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    await repo.upsert('transaction', SPACE, 'split1', {
      accountId: 'main', date: '2026-07-05', amountCents: -6500, currency: 'EUR',
      merchant: 'Phone bill', catId: 'telecom', txType: 'expense', needsReview: 0,
      splits: [
        { id: 'p1', catId: 'telecom', amountCents: 4000 },
        { id: 'p2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving', label: 'Device pot' },
      ],
    });

    expect(await migrateBareSpecialRows(store, repo)).toBe(1);
    const row = await store.get('transaction', 'split1');
    const part = row?.splits?.find((s) => s.id === 'p2');
    expect(part?.linkedAccountId).toBe(defaultAccountId(SPACE, 'saving'));
    expect(part?.transferPeerId).toBeTruthy();
    const partMirror = await store.get('transaction', part!.transferPeerId!);
    expect(partMirror).toMatchObject({ accountId: defaultAccountId(SPACE, 'saving'), amountCents: 2500 });
    // the untouched part stays untouched
    expect(row?.splits?.find((s) => s.id === 'p1')?.linkedAccountId).toBeUndefined();
  });
});
