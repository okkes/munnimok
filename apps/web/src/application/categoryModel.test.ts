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
      merchant: 'Set aside', catId: 'savingDeposit', needsReview: 0,
    });
    // interest is a value story, not a movement — never links
    await repo.upsert('transaction', SPACE, 'interest1', {
      accountId: 'main', date: '2026-07-02', amountCents: 300, currency: 'EUR',
      merchant: 'Interest', catId: 'savingInterest', needsReview: 0,
    });
    // rows ON a special account are the pot's own ledger — untouched
    await repo.upsert('transaction', SPACE, 'onpot1', {
      accountId: 'pot', date: '2026-07-03', amountCents: 2000, currency: 'EUR',
      merchant: 'Deposit', catId: 'savingDeposit', needsReview: 0,
    });

    const touched = await migrateBareSpecialRows(store, repo);
    expect(touched).toBe(1);

    const migrated = await store.get('transaction', 'bare1');
    expect(migrated?.linkedAccountId).toBe(defaultAccountId(SPACE, 'saving'));
    // the counterparty rule: a DEFAULT pot keeps the special category's type
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

  it('#221: bare movement rows link — the ATM pair onto the CASH wallet; #228 r3: a clueless transfer stands down instead', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    // the screenshot case: munni predicted Cash Withdraw, no counterparty
    await repo.upsert('transaction', SPACE, 'atm1', {
      accountId: 'main', date: '2026-07-10', amountCents: -100, currency: 'EUR',
      merchant: 'Geldmaat', catId: 'cashWithdraw', needsReview: 1,
    });
    await repo.upsert('transaction', SPACE, 'tout1', {
      accountId: 'main', date: '2026-07-11', amountCents: -2500, currency: 'EUR',
      merchant: 'Moved out', catId: 'transferOut', needsReview: 0,
    });
    await repo.upsert('transaction', SPACE, 'fund1', {
      accountId: 'main', date: '2026-07-12', amountCents: -4000, currency: 'EUR',
      merchant: 'To the pot', catId: 'fundingOut', needsReview: 0,
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

    // #228 r3 (user rule): "Moved out" names no tracked account — the
    // transfer stands down to Uncategorized and goes back to review;
    // the transfer default is never minted for it
    const tout = await store.get('transaction', 'tout1');
    expect(tout).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
    expect(tout?.linkedAccountId).toBeUndefined();
    expect(await store.get('account', defaultAccountId(SPACE, 'transfer'))).toBeUndefined();
    // funding links its pot but mints NOTHING (#152: funding shows no rows)
    const fund = await store.get('transaction', 'fund1');
    expect(fund?.linkedAccountId).toBe(defaultAccountId(SPACE, 'funding'));
    expect(fund?.transferPeerId).toBeUndefined();

    // every-boot idempotence: nothing left to do
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('#228 r3: a bare transfer whose text names a tracked account links IT — the bijection refiles the category', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    // the user's PayPal case: a camt-imported PayPal account exists in the space
    await repo.upsert('account', SPACE, 'pp', { name: 'PayPal o.doker@live.nl', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0 });
    // and a manual savings pot with a distinctive name
    await repo.upsert('account', SPACE, 'vak', { name: 'Vakantiepot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('transaction', SPACE, 'pp1', {
      accountId: 'main', date: '2026-07-14', amountCents: -799, currency: 'EUR',
      merchant: 'PayPal Europe S.a.r.l. et Cie S.C.A', catId: 'transferOut', needsReview: 0,
      description: 'Incasso · Naam: PayPal Europe S.a.r.l. et Cie S.C.A Omschrijving: 1051635911097/PAYPAL',
      counterIban: 'LU89751000135104200E',
    });
    await repo.upsert('transaction', SPACE, 'vak1', {
      accountId: 'main', date: '2026-07-15', amountCents: -12_000, currency: 'EUR',
      merchant: 'Overboeking naar Vakantiepot', catId: 'transferOut', needsReview: 0,
    });

    expect(await migrateBareSpecialRows(store, repo)).toBe(2);

    // the PayPal feed account is bank-fed: linked, no mirror minted —
    // the real PayPal-side row pairs later
    const pp = await store.get('transaction', 'pp1');
    expect(pp?.linkedAccountId).toBe('pp');
    expect(pp?.catId).toBe('transferOut');
    expect(pp?.transferPeerId).toBeUndefined();
    // the savings pot is manual: the link mints its leg and the category
    // refiles by the counter's kind (transfer → set aside)
    const vak = await store.get('transaction', 'vak1');
    expect(vak?.linkedAccountId).toBe('vak');
    expect(vak?.catId).toBe('savingDeposit');
    expect(vak?.transferPeerId).toBeTruthy();
    expect((await store.get('account', 'vak'))?.balanceCents).toBe(12_000);

    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('#228 r3: bare transfer PARTS resolve the same way — matched parts link, clueless parts go uncategorized and the container returns to review', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', SPACE, 'pp', { name: 'PayPal o.doker@live.nl', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('transaction', SPACE, 'split1', {
      accountId: 'main', date: '2026-07-16', amountCents: -3000, currency: 'EUR',
      merchant: 'PayPal Europe S.a.r.l. et Cie S.C.A', catId: 'transferOut', needsReview: 0,
      splits: [
        { id: 'p1', catId: 'transferOut', amountCents: 2000, txType: 'transfer' },
        { id: 'p2', catId: 'groceries', amountCents: 1000 },
      ],
    });
    await repo.upsert('transaction', SPACE, 'split2', {
      accountId: 'main', date: '2026-07-17', amountCents: -3000, currency: 'EUR',
      merchant: 'Verzamelbetaling', catId: 'transferOut', needsReview: 0,
      splits: [
        { id: 'q1', catId: 'transferOut', amountCents: 2000, txType: 'transfer' },
        { id: 'q2', catId: 'groceries', amountCents: 1000 },
      ],
    });

    expect(await migrateBareSpecialRows(store, repo)).toBe(2);

    const matched = await store.get('transaction', 'split1');
    expect(matched?.splits?.[0]).toMatchObject({ id: 'p1', catId: 'transferOut', linkedAccountId: 'pp' });
    expect(matched?.needsReview).toBe(0);
    // no clue: the part stands down and the human decides again
    const clueless = await store.get('transaction', 'split2');
    expect(clueless?.splits?.[0]).toMatchObject({ id: 'q1', catId: 'uncategorized' });
    expect(clueless?.splits?.[0]?.linkedAccountId).toBeUndefined();
    expect(clueless?.splits?.[0]?.txType).toBeUndefined();
    expect(clueless?.needsReview).toBe(1);

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
      merchant: 'Phone bill', catId: 'telecom', needsReview: 0,
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
