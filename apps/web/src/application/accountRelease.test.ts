// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { writeTxTransform } from '@/db/joined';
import { accountLinkId, mirrorTxId, txMetaId } from '@/domain/feedIds';
import { HlcClock } from '@/sync/hlc';
import { releaseAccountReferences, repairDanglingCounterparties } from './accountRelease';
import { removeManualAccount } from './accountPurge';

const SPACE = 's1';
const FEED = 'feed1';

describe('#544: an account leaving a space takes its counterparty references with it', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function fresh() {
    const store = new DexieBackend(new MunniDB(`munni_release_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('release'), { trackOutbox: false });
    await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR' });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    return { store, repo };
  }

  /** a PayPal feed account attached to the space, with one of its rows */
  async function attachedFeed(repo: Repo) {
    await repo.upsert('account', FEED, 'pp', { name: 'Okkes Doker', type: 'checking', source: 'connector', currency: 'EUR', balanceCents: 0 });
    await repo.upsert('accountLink', SPACE, accountLinkId(SPACE, FEED), { feedSpaceId: FEED, accountId: 'pp', type: 'checking' });
    await repo.upsert('transaction', FEED, 'ppRow', {
      accountId: 'pp', date: '2026-10-13', amountCents: 2999, currency: 'EUR', merchant: 'From bank', needsReview: 1,
    });
  }

  const own = (id: string, fields: object) => ({ id, spaceId: SPACE, feedSpaceId: undefined, needsReview: 0 as const, ...fields });

  it('a detached feed account: the rows naming it keep their category, lose the link and go back to the review', async () => {
    const { store, repo } = await fresh();
    await attachedFeed(repo);
    await repo.upsert('account', SPACE, 'pot', { name: 'Holiday pot', type: 'savings', source: 'manual', currency: 'EUR', balanceCents: 0 });
    // the screenshot: the bank's PayPal charge points at the PayPal account, paired with its row
    await repo.upsert('transaction', SPACE, 'bankRow', {
      accountId: 'main', date: '2026-10-13', amountCents: -2999, currency: 'EUR', merchant: 'PayPal (Europe)', catId: 'transferOut', needsReview: 0,
    });
    await writeTxTransform(repo, own('bankRow', {}), { linkedAccountId: 'pp', transferPeerId: 'ppRow' });
    // the PayPal row's own overlay in this space pairs back — and a second PayPal row set money aside in the manual pot
    await writeTxTransform(repo, { id: 'ppRow', spaceId: SPACE, feedSpaceId: FEED, needsReview: 1 }, { linkedAccountId: 'main', transferPeerId: 'bankRow', catId: 'transferIn' });
    await repo.upsert('transaction', FEED, 'ppRow2', { accountId: 'pp', date: '2026-10-14', amountCents: -1000, currency: 'EUR', merchant: 'Pot', needsReview: 1 });
    await writeTxTransform(repo, { id: 'ppRow2', spaceId: SPACE, feedSpaceId: FEED, needsReview: 1 }, { linkedAccountId: 'pot', catId: 'savingDeposit' });
    const leg = mirrorTxId('ppRow2');
    expect((await store.get('transaction', leg))?.accountId).toBe('pot');
    expect((await store.get('account', 'pot'))?.balanceCents).toBe(1000);
    await repo.upsert('recurring', SPACE, 'rec1', { name: 'PayPal top-up', catId: 'transferOut', amountCents: -2999, every: 'month', dueDay: 13, active: 1, linkedAccountId: 'pp' });

    await repo.remove('accountLink', SPACE, accountLinkId(SPACE, FEED));
    expect(await releaseAccountReferences(store, repo, SPACE, 'pp')).toBe(2);

    const bank = await store.get('transaction', 'bankRow');
    expect(bank).toMatchObject({ catId: 'transferOut', needsReview: 1 });
    expect(bank?.linkedAccountId ?? undefined).toBeUndefined();
    expect(bank?.transferPeerId ?? undefined).toBeUndefined();
    // the leg the PayPal row generated stays where the money went — an ordinary row to look at again
    const kept = await store.get('transaction', leg);
    expect(kept).toMatchObject({ deleted: 0, accountId: 'pot', needsReview: 1 });
    expect(kept?.linkedAccountId ?? undefined).toBeUndefined();
    expect((await store.get('account', 'pot'))?.balanceCents).toBe(1000);
    // the leaving account's own overlays forget the space's links (a later re-attach starts without half pairs)
    const ppMeta = await store.get('txMeta', txMetaId(SPACE, 'ppRow'));
    expect(ppMeta?.catId).toBe('transferIn');
    expect(ppMeta?.linkedAccountId ?? undefined).toBeUndefined();
    expect((await store.get('recurring', 'rec1'))?.linkedAccountId ?? undefined).toBeUndefined();
    // nothing left to let go
    expect(await releaseAccountReferences(store, repo, SPACE, 'pp')).toBe(0);
  });

  it('a deleted manual account: its generated legs retire with the links, a part lets go on its own, recorded rows stay', async () => {
    const { store, repo } = await fresh();
    await repo.upsert('account', SPACE, 'loan', { name: 'ING Loan 1', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -1_000_000 });
    await repo.upsert('transaction', SPACE, 'pay1', {
      accountId: 'main', date: '2026-10-01', amountCents: -6324, currency: 'EUR', merchant: 'Incasso lening', catId: 'loanRepayment', needsReview: 0,
    });
    await writeTxTransform(repo, own('pay1', {}), { linkedAccountId: 'loan' });
    const leg = mirrorTxId('pay1');
    expect((await store.get('transaction', leg))?.accountId).toBe('loan');
    await repo.upsert('transaction', SPACE, 'split1', {
      accountId: 'main', date: '2026-10-02', amountCents: -10_000, currency: 'EUR', merchant: 'Mixed', catId: 'groceries', needsReview: 0,
      splits: [{ id: 'p1', catId: 'groceries', amountCents: 4000 }],
    });
    await writeTxTransform(repo, own('split1', {}), {
      splits: [
        { id: 'p1', catId: 'groceries', amountCents: 4000 },
        { id: 'p2', catId: 'loanRepayment', amountCents: 6000, linkedAccountId: 'loan' },
      ],
    });
    // a row recorded ON the loan by hand
    await repo.upsert('transaction', SPACE, 'onLoan', {
      accountId: 'loan', date: '2026-09-01', amountCents: -500, currency: 'EUR', merchant: 'Fee', catId: 'debtFees', needsReview: 0,
    });

    const account = (await store.get('account', 'loan'))!;
    await removeManualAccount(store, repo, account);

    expect((await store.get('account', 'loan'))?.deleted).toBe(1);
    const pay = await store.get('transaction', 'pay1');
    expect(pay).toMatchObject({ catId: 'loanRepayment', needsReview: 1 });
    expect(pay?.linkedAccountId ?? undefined).toBeUndefined();
    expect((await store.get('transaction', leg))?.deleted).toBe(1);
    const split = await store.get('transaction', 'split1');
    expect(split?.needsReview).toBe(1);
    const part = split?.splits?.find((p) => p.id === 'p2');
    expect(part?.catId).toBe('loanRepayment');
    expect(part?.linkedAccountId).toBeUndefined();
    expect(part?.transferPeerId).toBeUndefined();
    // the delete sheet promises it: transactions recorded on the account stay
    expect((await store.get('transaction', 'onLoan'))?.deleted).toBe(0);
  });

  it('repairs what earlier detaches and deletes left behind — and leaves an account it does not know alone', async () => {
    const { store, repo } = await fresh();
    await attachedFeed(repo);
    await repo.upsert('account', SPACE, 'old', { name: 'Old loan', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -5000 });
    // linked while everything was live …
    await repo.upsert('transaction', SPACE, 'toFeed', {
      accountId: 'main', date: '2026-10-13', amountCents: -2999, currency: 'EUR', merchant: 'PayPal', catId: 'transferOut', needsReview: 0, linkedAccountId: 'pp',
    });
    await repo.upsert('transaction', SPACE, 'toOld', {
      accountId: 'main', date: '2026-10-01', amountCents: -100, currency: 'EUR', merchant: 'Pay', catId: 'loanRepayment', needsReview: 0,
    });
    await writeTxTransform(repo, own('toOld', {}), { linkedAccountId: 'old' });
    // … a row naming an account this device never saw (its link may not have arrived yet)
    await repo.upsert('transaction', SPACE, 'toUnknown', {
      accountId: 'main', date: '2026-10-02', amountCents: -100, currency: 'EUR', merchant: 'X', catId: 'transferOut', needsReview: 0, linkedAccountId: 'ghost',
    });
    // … then detached and deleted the old way: nothing let go
    await repo.remove('accountLink', SPACE, accountLinkId(SPACE, FEED));
    await repo.remove('account', SPACE, 'old');

    expect(await repairDanglingCounterparties(store, repo)).toBe(2);
    expect((await store.get('transaction', 'toFeed'))?.linkedAccountId ?? undefined).toBeUndefined();
    expect((await store.get('transaction', 'toFeed'))?.needsReview).toBe(1);
    expect((await store.get('transaction', 'toOld'))?.linkedAccountId ?? undefined).toBeUndefined();
    // the leg the dead loan still held goes with the link
    expect((await store.get('transaction', mirrorTxId('toOld')))?.deleted).toBe(1);
    expect((await store.get('transaction', 'toUnknown'))?.linkedAccountId).toBe('ghost');
    // idempotent: every boot, nothing left the second time
    expect(await repairDanglingCounterparties(store, repo)).toBe(0);
  });
});
