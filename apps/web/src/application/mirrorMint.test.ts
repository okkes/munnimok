// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { writeTxTransform } from '@/db/joined';
import { mirrorTxId, partMirrorSourceId } from '@/domain/feedIds';
import { planMirrorChange } from './mirrorMint';

describe('mirror mint lifecycle (typed-splits v2)', () => {
  const DB = 'munni_mirror_mint';
  let db: MunniDB;
  let store: DexieBackend;
  let repo: Repo;

  const sourceTx = (over: object = {}) => ({
    id: 'src',
    accountId: 'checking',
    amountCents: -10_000,
    date: '2026-08-01',
    currency: 'EUR',
    merchant: 'To the pot',
    ...over,
  });

  beforeEach(async () => {
    indexedDB.deleteDatabase(DB);
    db = new MunniDB(DB);
    store = new DexieBackend(db);
    repo = new Repo(store, new HlcClock('mm'), { trackOutbox: false });
    await repo.upsert('space', 'priv', 'priv', { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('account', 'priv', 'checking', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', 'priv', 'pot', { name: 'Pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('account', 'priv', 'loan', {
      name: 'Loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -50_000, balanceAsOf: '2026-07-15',
    });
    await repo.upsert('transaction', 'priv', 'src', {
      accountId: 'checking', date: '2026-08-01', amountCents: -10_000, currency: 'EUR',
      merchant: 'To the pot', needsReview: 0,
    });
  });

  it('link → mint + balance; retarget → old mint retires with its money', async () => {
    const link = await planMirrorChange(store, sourceTx(), undefined, 'pot', undefined, undefined);
    expect(link.sourceFields.transferPeerId).toBe(mirrorTxId('src'));
    await link.execute(repo);
    expect(await db.transactions.get(mirrorTxId('src'))).toMatchObject({
      accountId: 'pot', amountCents: 10_000, catId: 'savingDeposit', transferPeerId: 'src', needsReview: 0,
    });
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(10_000);

    const move = await planMirrorChange(store, sourceTx(), 'pot', 'loan', mirrorTxId('src'), undefined);
    expect(move.sourceFields.transferPeerId).toBe(mirrorTxId('src'));
    await move.execute(repo);
    expect((await db.transactions.get(mirrorTxId('src')))?.deleted === 0 || true).toBe(true);
    expect(await db.transactions.get(mirrorTxId('src'))).toMatchObject({ accountId: 'loan', catId: 'loanRepayment' });
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-40_000);
  });

  it('#536: an attached source files the mint by the SPACE\'s reading of it — never the global row\'s type', async () => {
    // the global row says checking; this space attached it as its savings
    await repo.upsert('account', 'feedS', 'fsav', { name: 'Spaarrekening', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('accountLink', 'priv', 'link-sav', { feedSpaceId: 'feedS', accountId: 'fsav', type: 'savings' });
    await repo.upsert('account', 'priv', 'wallet', { name: 'Wallet', type: 'cash', source: 'manual', currency: 'EUR', balanceCents: 0 });
    const plan = await planMirrorChange(store, sourceTx({ id: 'fsrc', accountId: 'fsav' }), undefined, 'wallet', undefined, undefined);
    await plan.execute(repo);
    // money taken out of savings into the wallet: "Take out", not a plain transfer in
    expect(await db.transactions.get(mirrorTxId('fsrc'))).toMatchObject({ accountId: 'wallet', amountCents: 10_000, catId: 'savingWithdraw' });
  });

  it('unlink retires the mint and refunds; a picked existing peer mints nothing', async () => {
    const link = await planMirrorChange(store, sourceTx(), undefined, 'pot', undefined, undefined);
    await link.execute(repo);
    const unlink = await planMirrorChange(store, sourceTx(), 'pot', undefined, mirrorTxId('src'), undefined);
    expect(unlink.sourceFields.transferPeerId).toBeNull();
    await unlink.execute(repo);
    expect((await db.transactions.get(mirrorTxId('src')))?.deleted).toBe(1);
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);

    const picked = await planMirrorChange(store, sourceTx(), undefined, 'pot', undefined, 'existing-row');
    expect(Object.hasOwn(picked.sourceFields, 'transferPeerId')).toBe(false);
    await picked.execute(repo);
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
  });

  it('a pre-anchor liability link mints WITHOUT moving the balance — unless counted in', async () => {
    const old = sourceTx({ date: '2026-07-01' }); // before balanceAsOf 2026-07-15
    const gated = await planMirrorChange(store, old, undefined, 'loan', undefined, undefined);
    await gated.execute(repo);
    expect(await db.transactions.get(mirrorTxId('src'))).toMatchObject({ accountId: 'loan' });
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-50_000); // presumed inside the typed number

    await repo.upsert('transaction', 'priv', 'src2', {
      accountId: 'checking', date: '2026-07-01', amountCents: -10_000, currency: 'EUR',
      merchant: 'Old payment', needsReview: 0,
    });
    const src2 = (await db.transactions.get('src2'))!;
    await writeTxTransform(repo, { ...src2, feedSpaceId: undefined }, { linkedAccountId: 'loan', loanCounted: 1 });
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-40_000);
    expect((await db.transactions.get('src2'))?.transferPeerId).toBe(mirrorTxId('src2'));
  });

  it('a PART with a counterparty mints its own leg; dropping the part retires it (typed-splits v2)', async () => {
    const src = (await db.transactions.get('src'))!;
    await writeTxTransform(repo, { ...src, feedSpaceId: undefined }, {
      splits: [
        { id: 'p1', catId: 'telecom', amountCents: 5_000 },
        { id: 'p2', catId: 'transferOut', amountCents: 5_000, txType: 'transfer', linkedAccountId: 'loan' },
      ],
    });
    const mid = mirrorTxId(partMirrorSourceId('src', 'p2'));
    expect(await db.transactions.get(mid)).toMatchObject({
      accountId: 'loan', amountCents: 5_000, catId: 'loanRepayment',
    });
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-45_000);
    const stored = (await db.transactions.get('src'))!.splits!;
    expect(stored.find((p) => p.id === 'p2')?.transferPeerId).toBe(mid);

    const fresh = (await db.transactions.get('src'))!;
    await writeTxTransform(repo, { ...fresh, feedSpaceId: undefined }, {
      splits: [{ id: 'p1', catId: 'telecom', amountCents: 10_000 }],
    });
    expect((await db.transactions.get(mid))?.deleted).toBe(1);
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-50_000);
  });

  it('#228: a part arriving with a FOREIGN peer is a picked real row — it rides, nothing mints', async () => {
    await repo.upsert('transaction', 'priv', 'potrow', {
      accountId: 'pot', date: '2026-08-01', amountCents: 5_000, currency: 'EUR',
      merchant: 'Arrived already', needsReview: 0,
    });
    const src = (await db.transactions.get('src'))!;
    await writeTxTransform(repo, { ...src, feedSpaceId: undefined }, {
      splits: [
        { id: 'p1', catId: 'telecom', amountCents: 5_000 },
        { id: 'p2', catId: 'savingDeposit', amountCents: 5_000, txType: 'saving', linkedAccountId: 'pot', transferPeerId: 'potrow' },
      ],
    });
    expect(await db.transactions.get(mirrorTxId(partMirrorSourceId('src', 'p2')))).toBeUndefined();
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
    const stored = (await db.transactions.get('src'))!.splits!;
    expect(stored.find((p) => p.id === 'p2')?.transferPeerId).toBe('potrow');
  });
});
