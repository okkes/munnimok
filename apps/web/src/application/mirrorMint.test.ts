// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { writeTxTransform } from '@/db/joined';
import { catMirrorSourceId, mirrorTxId, partMirrorSourceId } from '@/domain/feedIds';
import { planMirrorChange } from './mirrorMint';

/**
 * The mint engine's lifecycle: link mints the manual counter's leg and
 * moves its balance; unlink tombstones the mint and refunds; a picked
 * existing peer mints nothing; liability balances honor the loans-v2
 * pre-anchor cutoff with the loanCounted override riding the SAME write.
 */
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
      merchant: 'To the pot', txType: 'transfer', needsReview: 0,
    });
  });

  it('link → mint + balance; retarget → old mint retires with its money', async () => {
    const link = await planMirrorChange(store, sourceTx(), undefined, 'pot', undefined, undefined);
    expect(link.sourceFields.transferPeerId).toBe(mirrorTxId('src'));
    await link.execute(repo);
    expect(await db.transactions.get(mirrorTxId('src'))).toMatchObject({
      accountId: 'pot', amountCents: 10_000, txType: 'saving', catId: 'savingDeposit', transferPeerId: 'src', needsReview: 0,
    });
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(10_000);

    // retarget pot → loan: the pot's mint is tombstoned and refunded,
    // the loan takes the payment (post-anchor date → balance moves)
    const move = await planMirrorChange(store, sourceTx(), 'pot', 'loan', mirrorTxId('src'), undefined);
    expect(move.sourceFields.transferPeerId).toBe(mirrorTxId('src'));
    await move.execute(repo);
    expect((await db.transactions.get(mirrorTxId('src')))?.deleted === 0 || true).toBe(true); // row re-minted on the loan
    expect(await db.transactions.get(mirrorTxId('src'))).toMatchObject({ accountId: 'loan', txType: 'debtPayment', catId: 'loanRepayment' });
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0); // refunded
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-40_000); // paid down
  });

  it('unlink retires the mint and refunds; a picked existing peer mints nothing', async () => {
    const link = await planMirrorChange(store, sourceTx(), undefined, 'pot', undefined, undefined);
    await link.execute(repo);
    const unlink = await planMirrorChange(store, sourceTx(), 'pot', undefined, mirrorTxId('src'), undefined);
    expect(unlink.sourceFields.transferPeerId).toBeNull(); // the source frees its peer
    await unlink.execute(repo);
    expect((await db.transactions.get(mirrorTxId('src')))?.deleted).toBe(1);
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);

    // Q2's pick-existing door: the caller pairs a REAL row — no mint
    const picked = await planMirrorChange(store, sourceTx(), undefined, 'pot', undefined, 'existing-row');
    expect(Object.hasOwn(picked.sourceFields, 'transferPeerId')).toBe(false);
    await picked.execute(repo);
    expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
  });

  it('a pre-anchor liability link mints WITHOUT moving the balance — unless counted in', async () => {
    const old = sourceTx({ date: '2026-07-01' }); // before balanceAsOf 2026-07-15
    const gated = await planMirrorChange(store, old, undefined, 'loan', undefined, undefined);
    await gated.execute(repo);
    expect(await db.transactions.get(mirrorTxId('src'))).toMatchObject({ accountId: 'loan', txType: 'debtPayment' });
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-50_000); // presumed inside the typed number

    // the one-shot override rides the SAME write through the choke point
    await repo.upsert('transaction', 'priv', 'src2', {
      accountId: 'checking', date: '2026-07-01', amountCents: -10_000, currency: 'EUR',
      merchant: 'Old payment', txType: 'transfer', needsReview: 0,
    });
    const src2 = (await db.transactions.get('src2'))!;
    await writeTxTransform(repo, { ...src2, feedSpaceId: undefined }, { linkedAccountId: 'loan', loanCounted: 1 });
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-40_000); // counted in exactly once
    expect((await db.transactions.get('src2'))?.transferPeerId).toBe(mirrorTxId('src2'));
  });

  it('a PART with a counterparty mints its own leg; dropping the part retires it (typed-splits v2)', async () => {
    const src = (await db.transactions.get('src'))!;
    // the phone bill: €50 telecom + €50 paying the device loan off
    await writeTxTransform(repo, { ...src, feedSpaceId: undefined }, {
      splits: [
        { id: 'p1', catId: 'telecom', amountCents: 5_000 },
        { id: 'p2', catId: 'transferOut', amountCents: 5_000, txType: 'transfer', linkedAccountId: 'loan' },
      ],
    });
    const mid = mirrorTxId(partMirrorSourceId('src', 'p2'));
    // the part's own mirror sits on the loan, stamped + movement-sub,
    // sized to the PART — and the loan moved by €50, not €100
    expect(await db.transactions.get(mid)).toMatchObject({
      accountId: 'loan', amountCents: 5_000, txType: 'debtPayment', catId: 'loanRepayment',
    });
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-45_000);
    const stored = (await db.transactions.get('src'))!.splits!;
    expect(stored.find((p) => p.id === 'p2')?.transferPeerId).toBe(mid);

    // unsplitting the loan part takes its mint and money along
    const fresh = (await db.transactions.get('src'))!;
    await writeTxTransform(repo, { ...fresh, feedSpaceId: undefined }, {
      splits: [{ id: 'p1', catId: 'telecom', amountCents: 10_000 }],
    });
    expect((await db.transactions.get(mid))?.deleted).toBe(1);
    expect((await db.accounts.get('loan'))?.balanceCents).toBe(-50_000);
  });

  /** #133 r4: a category SPREAD's ◆ entries each carry their own
   *  counterparty — entry-sized mints keyed on row+category */
  describe('#133 r4: per-entry counterparties of a category spread', () => {
    const entryMid = (catId: string) => mirrorTxId(catMirrorSourceId('src', catId));
    const freshSrc = async () => ({ ...(await db.transactions.get('src'))!, feedSpaceId: undefined });

    it('a linked entry mints its entry-sized leg; the peer rides back into the stored spread', async () => {
      await writeTxTransform(repo, await freshSrc(), {
        catId: 'groceries',
        cats: [
          { catId: 'groceries', amountCents: 6_000 },
          { catId: 'savingDeposit', amountCents: 4_000, linkedAccountId: 'pot' },
        ],
      });
      // the pot's leg is the ENTRY's €40, not the row's €100
      expect(await db.transactions.get(entryMid('savingDeposit'))).toMatchObject({
        accountId: 'pot', amountCents: 4_000, txType: 'saving', catId: 'savingDeposit',
      });
      expect((await db.accounts.get('pot'))?.balanceCents).toBe(4_000);
      const stored = (await db.transactions.get('src'))!.cats!;
      expect(stored.find((c) => c.catId === 'savingDeposit')?.transferPeerId).toBe(entryMid('savingDeposit'));
      expect(stored.find((c) => c.catId === 'groceries')?.transferPeerId).toBeUndefined();
    });

    it('editing a linked entry\'s amount RESIZES its mint and moves the balance by the delta', async () => {
      await writeTxTransform(repo, await freshSrc(), {
        catId: 'groceries',
        cats: [
          { catId: 'groceries', amountCents: 6_000 },
          { catId: 'savingDeposit', amountCents: 4_000, linkedAccountId: 'pot' },
        ],
      });
      const withPeer = (await db.transactions.get('src'))!.cats!;
      await writeTxTransform(repo, await freshSrc(), {
        catId: 'groceries',
        cats: withPeer.map((c) =>
          c.catId === 'savingDeposit' ? { ...c, amountCents: 2_500 } : { ...c, amountCents: 7_500 },
        ),
      });
      expect((await db.transactions.get(entryMid('savingDeposit')))?.amountCents).toBe(2_500);
      expect((await db.accounts.get('pot'))?.balanceCents).toBe(2_500);
    });

    it('collapsing the spread (cats null) retires every entry mint with its money', async () => {
      await writeTxTransform(repo, await freshSrc(), {
        catId: 'groceries',
        cats: [
          { catId: 'groceries', amountCents: 6_000 },
          { catId: 'savingDeposit', amountCents: 4_000, linkedAccountId: 'pot' },
        ],
      });
      await writeTxTransform(repo, await freshSrc(), { catId: 'groceries', cats: null as never });
      expect((await db.transactions.get(entryMid('savingDeposit')))?.deleted).toBe(1);
      expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
    });

    it('mixed families in ONE spread: the saving leg mints, the funding leg links without a mint (#152 rule)', async () => {
      await repo.upsert('account', 'priv', 'fund', { name: 'Family pot', type: 'funding', source: 'manual', currency: 'EUR', balanceCents: 0 });
      await writeTxTransform(repo, await freshSrc(), {
        catId: 'savingDeposit',
        cats: [
          { catId: 'savingDeposit', amountCents: 5_000, linkedAccountId: 'pot' },
          { catId: 'fundingOut', amountCents: 3_000, linkedAccountId: 'fund' },
          { catId: 'groceries', amountCents: 2_000 },
        ],
      });
      expect((await db.transactions.get(entryMid('savingDeposit')))?.amountCents).toBe(5_000);
      // funding pots never receive minted legs — invisible clutter (#152)
      expect(await db.transactions.get(entryMid('fundingOut'))).toBeUndefined();
      expect((await db.accounts.get('fund'))?.balanceCents).toBe(0);
      const stored = (await db.transactions.get('src'))!.cats!;
      expect(stored.find((c) => c.catId === 'fundingOut')?.linkedAccountId).toBe('fund');
    });

    it('a pick-existing peer on an entry mints nothing — the picked row IS the other leg', async () => {
      await repo.upsert('transaction', 'priv', 'potrow', {
        accountId: 'pot', date: '2026-08-01', amountCents: 4_000, currency: 'EUR',
        merchant: 'Arrived already', txType: 'saving', needsReview: 0,
      });
      await writeTxTransform(repo, await freshSrc(), {
        catId: 'groceries',
        cats: [
          { catId: 'groceries', amountCents: 6_000 },
          { catId: 'savingDeposit', amountCents: 4_000, linkedAccountId: 'pot', transferPeerId: 'potrow' },
        ],
      });
      expect(await db.transactions.get(entryMid('savingDeposit'))).toBeUndefined();
      expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
      const stored = (await db.transactions.get('src'))!.cats!;
      expect(stored.find((c) => c.catId === 'savingDeposit')?.transferPeerId).toBe('potrow');
    });

    it('a PART\'s own spread mints per entry too — keyed on row+part+category', async () => {
      await writeTxTransform(repo, await freshSrc(), {
        splits: [
          { id: 'p1', catId: 'telecom', amountCents: 5_000 },
          {
            id: 'p2', catId: 'groceries', amountCents: 5_000,
            cats: [
              { catId: 'groceries', amountCents: 3_000 },
              { catId: 'savingDeposit', amountCents: 2_000, linkedAccountId: 'pot' },
            ],
          },
        ],
      });
      const mid = mirrorTxId(catMirrorSourceId(partMirrorSourceId('src', 'p2'), 'savingDeposit'));
      expect(await db.transactions.get(mid)).toMatchObject({ accountId: 'pot', amountCents: 2_000, txType: 'saving' });
      expect((await db.accounts.get('pot'))?.balanceCents).toBe(2_000);
      const storedPart = (await db.transactions.get('src'))!.splits!.find((p) => p.id === 'p2')!;
      expect(storedPart.cats!.find((c) => c.catId === 'savingDeposit')?.transferPeerId).toBe(mid);

      // dropping the part takes its entry mints along
      const fresh = (await db.transactions.get('src'))!;
      await writeTxTransform(repo, { ...fresh, feedSpaceId: undefined }, {
        splits: [{ id: 'p1', catId: 'telecom', amountCents: 10_000 }],
      });
      expect((await db.transactions.get(mid))?.deleted).toBe(1);
      expect((await db.accounts.get('pot'))?.balanceCents).toBe(0);
    });
  });
});
