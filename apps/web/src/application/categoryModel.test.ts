// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { writeTxTransform } from '@/db/joined';
import { HlcClock } from '@/sync/hlc';
import { cashWalletId, defaultAccountId, ensureCashWallet, retireDefaultAccounts, walletForAutoLink } from './defaultAccounts';
import { migrateBareSpecialRows, refileCashTransfers } from './categoryModel';

const SPACE = 's1';

describe('the cash wallet + the bare-row migration', () => {
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

  it('mints the cash wallet deterministically and idempotently; an automatic link never revives a deleted one', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    const id = await ensureCashWallet(store, repo, SPACE);
    expect(id).toBe(cashWalletId(SPACE));
    const minted = await store.get('account', id);
    expect(minted).toMatchObject({ type: 'cash', source: 'manual', defaultFor: 'cash', balanceCents: 0, currency: 'EUR' });
    // second call returns the same wallet without re-minting
    expect(await ensureCashWallet(store, repo, SPACE)).toBe(id);
    // #348: the person deleted it — automatic links leave it deleted, an explicit pick revives it
    await repo.remove('account', SPACE, id);
    expect(await walletForAutoLink(store, repo, SPACE)).toBeNull();
    expect((await store.get('account', id))?.deleted).toBe(1);
    expect(await ensureCashWallet(store, repo, SPACE)).toBe(id);
    expect((await store.get('account', id))?.deleted).toBe(0);
  });

  it('#546: a bare pot movement links the account of its kind its text names — no clue, it stays bare; value stories untouched', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    await repo.upsert('account', SPACE, 'pot', { name: 'Holiday pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    // a checking account named in the text is the wrong kind for a set-aside
    await repo.upsert('account', SPACE, 'other', { name: 'Holiday current', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    // the bare set-aside: ◆ movement category, no counterparty — its text names the pot
    await repo.upsert('transaction', SPACE, 'bare1', {
      accountId: 'main', date: '2026-07-01', amountCents: -5000, currency: 'EUR',
      merchant: 'To Holiday', catId: 'savingDeposit', needsReview: 0,
    });
    // a bare debt payment naming no tracked account stays bare: the review asks for the loan
    await repo.upsert('transaction', SPACE, 'debt1', {
      accountId: 'main', date: '2026-07-01', amountCents: -6324, currency: 'EUR',
      merchant: 'Incasso lening', catId: 'loanRepayment', needsReview: 1,
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
    expect(migrated?.linkedAccountId).toBe('pot');
    expect(migrated?.catId).toBe('savingDeposit');
    // the pot's leg exists and carries the money
    expect(migrated?.transferPeerId).toBeTruthy();
    const mirror = await store.get('transaction', migrated!.transferPeerId!);
    expect(mirror).toMatchObject({ accountId: 'pot', amountCents: 5000 });

    const debt = await store.get('transaction', 'debt1');
    expect(debt).toMatchObject({ catId: 'loanRepayment', needsReview: 1 });
    expect(debt?.linkedAccountId).toBeUndefined();
    expect((await store.get('transaction', 'interest1'))?.linkedAccountId).toBeUndefined();
    expect((await store.get('transaction', 'onpot1'))?.linkedAccountId).toBeUndefined();
    // no default pot is minted for anything (#546)
    for (const family of ['saving', 'debtPayment', 'transfer'] as const) {
      expect(await store.get('account', defaultAccountId(SPACE, family))).toBeUndefined();
    }
    // the fold runs every boot; idempotence comes from linked rows skipping
    // and bare rows without a clue writing nothing
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('the ATM pair links the CASH wallet; #228 r3: a clueless transfer stands down; #546: a clueless funding stays bare', async () => {
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

    expect(await migrateBareSpecialRows(store, repo)).toBe(2);

    const atm = await store.get('transaction', 'atm1');
    expect(atm?.linkedAccountId).toBe(cashWalletId(SPACE));
    expect(atm?.needsReview).toBe(1); // healing is not reviewing
    // the wallet's leg files by ITS counter's kind (the checking source)
    const atmMirror = await store.get('transaction', atm!.transferPeerId!);
    expect(atmMirror).toMatchObject({ accountId: cashWalletId(SPACE), amountCents: 100, catId: 'transferIn' });
    // the wallet's balance moved with the leg
    expect((await store.get('account', cashWalletId(SPACE)))?.balanceCents).toBe(100);

    // #228 r3 (user rule): "Moved out" names no tracked account — the
    // transfer stands down to Uncategorized and goes back to review
    const tout = await store.get('transaction', 'tout1');
    expect(tout).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
    expect(tout?.linkedAccountId).toBeUndefined();
    // no funding account named: the row keeps its story and waits for the person
    const fund = await store.get('transaction', 'fund1');
    expect(fund).toMatchObject({ catId: 'fundingOut' });
    expect(fund?.linkedAccountId).toBeUndefined();
    expect(await store.get('account', defaultAccountId(SPACE, 'funding'))).toBeUndefined();

    // every-boot idempotence: nothing left to do
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('#348: a cash wallet the person deleted is never revived by the ATM fold — the row stays bare', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await ensureCashWallet(store, repo, SPACE);
    await repo.remove('account', SPACE, cashWalletId(SPACE));
    await repo.upsert('transaction', SPACE, 'atm2', {
      accountId: 'main', date: '2026-07-10', amountCents: -100, currency: 'EUR',
      merchant: 'Geldmaat', catId: 'cashWithdraw', needsReview: 1,
    });
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
    expect((await store.get('transaction', 'atm2'))?.linkedAccountId).toBeUndefined();
    expect((await store.get('account', cashWalletId(SPACE)))?.deleted).toBe(1);
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

  it('a transfer whose account left the space keeps its category while it waits in the review, row and part alike — a clue still links, a prediction nobody filed still stands down', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', SPACE, 'pp', { name: 'PayPal o.doker@live.nl', type: 'checking', source: 'camt053', currency: 'EUR', balanceCents: 0 });
    const bank = defaultAccountId(SPACE, 'transfer');
    await repo.upsert('account', SPACE, bank, { name: 'Default bank account', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0, defaultFor: 'transfer' });
    await repo.upsert('transaction', SPACE, 'filed', {
      accountId: 'main', date: '2026-07-01', amountCents: -2500, currency: 'EUR', merchant: 'Overboeking', catId: 'transferOut', needsReview: 0,
    });
    await writeTxTransform(repo, { id: 'filed', spaceId: SPACE, feedSpaceId: undefined, needsReview: 0 }, { linkedAccountId: bank });
    await repo.upsert('transaction', SPACE, 'named', {
      accountId: 'main', date: '2026-07-02', amountCents: -799, currency: 'EUR', merchant: 'PayPal Europe S.a.r.l. et Cie S.C.A', catId: 'transferOut', needsReview: 1,
    });
    await repo.upsert('transaction', SPACE, 'split', {
      accountId: 'main', date: '2026-07-03', amountCents: -3000, currency: 'EUR', merchant: 'Verzamelbetaling', catId: 'transferOut', needsReview: 1,
      splits: [
        { id: 'q1', catId: 'transferOut', amountCents: 2000, txType: 'transfer' },
        { id: 'q2', catId: 'groceries', amountCents: 1000 },
      ],
    });

    await repo.upsert('transaction', SPACE, 'predicted', {
      accountId: 'main', date: '2026-07-04', amountCents: -1200, currency: 'EUR', merchant: 'Verzamelbetaling batch 42', catId: 'transferOut', needsReview: 1,
    });

    await retireDefaultAccounts(store, repo);
    expect(await migrateBareSpecialRows(store, repo)).toBe(2);

    expect(await store.get('transaction', 'filed')).toMatchObject({ catId: 'transferOut', needsReview: 1 });
    expect(await store.get('transaction', 'named')).toMatchObject({ linkedAccountId: 'pp', needsReview: 1 });
    expect(await store.get('transaction', 'predicted')).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
    expect((await store.get('transaction', 'split'))?.splits?.[0]).toMatchObject({ id: 'q1', catId: 'transferOut', txType: 'transfer' });
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
  });

  it('migrates bare movement PARTS of a split through the part-mirror machinery — a clueless part stays as it is', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 100_000 });
    await repo.upsert('account', SPACE, 'dev', { name: 'Devicepot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('transaction', SPACE, 'split1', {
      accountId: 'main', date: '2026-07-05', amountCents: -6500, currency: 'EUR',
      merchant: 'Phone bill + Devicepot', catId: 'telecom', needsReview: 0,
      splits: [
        { id: 'p1', catId: 'telecom', amountCents: 4000 },
        { id: 'p2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving', label: 'Device pot' },
      ],
    });
    await repo.upsert('transaction', SPACE, 'split2', {
      accountId: 'main', date: '2026-07-06', amountCents: -6500, currency: 'EUR',
      merchant: 'Phone bill', catId: 'telecom', needsReview: 0,
      splits: [
        { id: 'q1', catId: 'telecom', amountCents: 4000 },
        { id: 'q2', catId: 'savingDeposit', amountCents: 2500, txType: 'saving' },
      ],
    });

    expect(await migrateBareSpecialRows(store, repo)).toBe(1);
    const row = await store.get('transaction', 'split1');
    const part = row?.splits?.find((s) => s.id === 'p2');
    expect(part?.linkedAccountId).toBe('dev');
    expect(part?.transferPeerId).toBeTruthy();
    const partMirror = await store.get('transaction', part!.transferPeerId!);
    expect(partMirror).toMatchObject({ accountId: 'dev', amountCents: 2500 });
    // the untouched part stays untouched
    expect(row?.splits?.find((s) => s.id === 'p1')?.linkedAccountId).toBeUndefined();
    // no clue: the bare part waits for the person, nothing written
    expect((await store.get('transaction', 'split2'))?.splits?.find((s) => s.id === 'q2')?.linkedAccountId).toBeUndefined();
  });

  it('#536: the fold reads the SPACE\'s type for an attached account — a feed row the space calls savings is the pot\'s own ledger', async () => {
    const { store, repo } = fresh();
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR' });
    // the global row says checking; this space attached it as savings
    await repo.upsert('account', 'feed1', 'f-acct', { name: 'NL01 Feed', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('accountLink', SPACE, 'link1', { feedSpaceId: 'feed1', accountId: 'f-acct', type: 'savings' });
    await repo.upsert('transaction', 'feed1', 'feedrow', {
      accountId: 'f-acct', date: '2026-07-07', amountCents: 2000, currency: 'EUR', merchant: 'Deposit', needsReview: 1,
    });
    await repo.upsert('txMeta', SPACE, 'meta1', { txId: 'feedrow', catId: 'savingWithdraw', needsReview: 1 });
    // a stamped row is the pot's own ledger: never linked, nothing written
    expect(await migrateBareSpecialRows(store, repo)).toBe(0);
    expect((await store.get('txMeta', 'meta1'))?.linkedAccountId).toBeUndefined();
  });
});

describe('#574: a cash counter means the ATM pair', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('re-files "Transfer out/in" against a cash wallet as Cash withdraw/deposit — rows and parts, once', async () => {
    const store = new DexieBackend(new MunniDB(`munni_cashrefile_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('cashrefile'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', SPACE, 'other', { name: 'Other bank', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', SPACE, 'wallet', { name: 'Cash wallet', type: 'cash', source: 'manual', currency: 'EUR', balanceCents: 0, defaultFor: 'cash' });
    await repo.upsert('transaction', SPACE, 'out1', {
      accountId: 'main', date: '2026-07-01', amountCents: -5000, currency: 'EUR', merchant: 'ATM', catId: 'transferOut', linkedAccountId: 'wallet', needsReview: 0,
    });
    await repo.upsert('transaction', SPACE, 'in1', {
      accountId: 'main', date: '2026-07-02', amountCents: 3000, currency: 'EUR', merchant: 'Deposit', catId: 'transferIn', linkedAccountId: 'wallet', needsReview: 0,
    });
    // a transfer between bank accounts stays a transfer
    await repo.upsert('transaction', SPACE, 'out2', {
      accountId: 'main', date: '2026-07-03', amountCents: -1000, currency: 'EUR', merchant: 'Move', catId: 'transferOut', linkedAccountId: 'other', needsReview: 0,
    });
    await repo.upsert('transaction', SPACE, 'split1', {
      accountId: 'main', date: '2026-07-04', amountCents: -6000, currency: 'EUR', merchant: 'Mixed', catId: 'groceries', needsReview: 0,
      splits: [
        { id: 'p1', catId: 'groceries', amountCents: 4000 },
        { id: 'p2', catId: 'transferOut', amountCents: 2000, linkedAccountId: 'wallet' },
      ],
    });

    expect(await refileCashTransfers(store, repo)).toBe(3);
    expect((await store.get('transaction', 'out1'))?.catId).toBe('cashWithdraw');
    expect((await store.get('transaction', 'in1'))?.catId).toBe('cashDeposit');
    expect((await store.get('transaction', 'out2'))?.catId).toBe('transferOut');
    const parts = (await store.get('transaction', 'split1'))?.splits ?? [];
    expect(parts.map((p) => p.catId)).toEqual(['groceries', 'cashWithdraw']);
    expect(parts[1].linkedAccountId).toBe('wallet');
    // the money and the links stay where they were
    expect((await store.get('transaction', 'out1'))?.linkedAccountId).toBe('wallet');
    expect(await refileCashTransfers(store, repo)).toBe(0);
  });
});
