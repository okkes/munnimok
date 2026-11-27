// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { writeTxTransform } from '@/db/joined';
import { applyLoanLinkDelta, countPreAnchorTx, countsTowardLoan, isPristineLoan, loanStepOf, overpaidByPayment, settlePristineLoans, wouldOverpayCents } from './loanBalance';

const SPACE = 's1';

describe('loans v2 balance coupling', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function seeded() {
    const store = new DexieBackend(new MunniDB(`munni_loanbal_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('lb'), { trackOutbox: false });
    await repo.upsert('account', SPACE, 'loan1', {
      name: 'Car loan', type: 'loan', source: 'manual', currency: 'EUR',
      balanceCents: -50_000, balanceAsOf: '2026-06-01',
    });
    await repo.upsert('account', SPACE, 'bankloan', {
      name: 'Bank loan', type: 'loan', source: 'connector', currency: 'EUR', balanceCents: -90_000,
    });
    return { store, repo };
  }

  it('linking a payment pays the loan down; unlinking gives it back; draws deepen it', async () => {
    const { store, repo } = await seeded();
    const payment = { amountCents: -10_000, date: '2026-07-01' };
    await applyLoanLinkDelta(store, repo, payment, undefined, 'loan1');
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-40_000);
    await applyLoanLinkDelta(store, repo, payment, 'loan1', undefined);
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-50_000);
    await applyLoanLinkDelta(store, repo, { amountCents: 5_000, date: '2026-07-02' }, undefined, 'loan1');
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-55_000);
  });

  it('bank-fed loans and mirrored pairs never move', async () => {
    const { store, repo } = await seeded();
    await applyLoanLinkDelta(store, repo, { amountCents: -10_000, date: '2026-07-01' }, undefined, 'bankloan');
    expect((await store.get('account', 'bankloan'))?.balanceCents).toBe(-90_000);
    await applyLoanLinkDelta(store, repo, { amountCents: -10_000, date: '2026-07-01', transferPeerId: 'peer' }, undefined, 'loan1');
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-50_000);
  });

  it('pre-anchor rows are presumed baked into the typed balance — unless deliberately counted', async () => {
    const { store, repo } = await seeded();
    const old = { amountCents: -10_000, date: '2026-05-15' }; // before balanceAsOf
    expect(countsTowardLoan({ balanceAsOf: '2026-06-01' }, old)).toBe(false);
    await applyLoanLinkDelta(store, repo, old, undefined, 'loan1');
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-50_000);
    expect(countsTowardLoan({ balanceAsOf: '2026-06-01' }, { ...old, loanCounted: 1 })).toBe(true);
  });

  it('countPreAnchorTx applies once and stamps the marker through the callback', async () => {
    const { store, repo } = await seeded();
    let marked = false;
    const tx = {
      id: 't1', spaceId: SPACE, amountCents: -10_000, date: '2026-05-15',
      txType: 'debtPayment', needsReview: 0 as const, linkedAccountId: 'loan1',
    };
    const applied = await countPreAnchorTx(store, repo, tx as never, async () => {
      marked = true;
    });
    expect(applied).toBe(true);
    expect(marked).toBe(true);
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-40_000);
    const again = await countPreAnchorTx(store, repo, { ...tx, loanCounted: 1 } as never, async () => undefined);
    expect(again).toBe(false);
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-40_000);
  });
});

describe('#693: a loan paid back beyond what it owed', () => {
  const loan = { id: 'loan1', type: 'loan' as const, source: 'manual' as const, balanceCents: 70_000, balanceAsOf: '2026-06-01' };
  const row = (id: string, fields: Record<string, unknown>) => ({ id, accountId: 'main', date: '2026-11-24', amountCents: 0, ...fields }) as Parameters<typeof loanStepOf>[0];

  it('a row moves the loan from its own ledger by its amount, from another account by its opposite — never twice, never uncounted', () => {
    expect(loanStepOf(row('leg', { accountId: 'loan1', amountCents: 75_000 }), loan)).toEqual({ id: 'leg', date: '2026-11-24', deltaCents: 75_000 });
    expect(loanStepOf(row('pay', { linkedAccountId: 'loan1', amountCents: -75_000 }), loan)).toEqual({ id: 'pay', date: '2026-11-24', deltaCents: 75_000 });
    // its mirror on the ledger already carries it
    expect(loanStepOf(row('paired', { linkedAccountId: 'loan1', amountCents: -75_000, transferPeerId: 'leg' }), loan)).toBeNull();
    // older than the balance date: inside the typed balance, unless counted in by hand
    expect(loanStepOf(row('old', { linkedAccountId: 'loan1', amountCents: -75_000, date: '2026-05-01' }), loan)).toBeNull();
    expect(loanStepOf(row('counted', { linkedAccountId: 'loan1', amountCents: -75_000, date: '2026-05-01', loanCounted: 1 }), loan)?.deltaCents).toBe(75_000);
    expect(loanStepOf(row('gone', { accountId: 'loan1', amountCents: 75_000, deleted: 1 }), loan)).toBeNull();
    expect(loanStepOf(row('other', { linkedAccountId: 'loan2', amountCents: -75_000 }), loan)).toBeNull();
  });

  it('names the payment that went past zero and the part of it that was too much; a loan that still owes names none', () => {
    const txs = [
      row('borrow', { accountId: 'loan1', amountCents: -80_000, date: '2026-11-12' }),
      row('pay-a', { linkedAccountId: 'loan1', amountCents: -75_000 }),
      row('pay-b', { linkedAccountId: 'loan1', amountCents: -75_000 }),
      row('coffee', { amountCents: -450 }),
    ];
    expect([...overpaidByPayment(loan, txs)]).toEqual([['pay-b', 70_000]]);
    expect(overpaidByPayment({ ...loan, balanceCents: -5_000 }, txs).size).toBe(0);
    expect(overpaidByPayment({ ...loan, type: 'credit' }, txs).size).toBe(0);
  });

  it('before a payment is linked: what it pays beyond what the loan still owes — nothing where the link moves nothing', () => {
    const owing = { ...loan, balanceCents: -80_000 };
    const pay = { amountCents: -150_000, date: '2026-11-24' };
    expect(wouldOverpayCents(owing, pay)).toBe(70_000);
    expect(wouldOverpayCents(owing, { ...pay, amountCents: -80_000 })).toBe(0);
    expect(wouldOverpayCents({ ...owing, balanceCents: 0 }, { ...pay, amountCents: -1_000 })).toBe(1_000);
    // money coming in is a draw; a mirrored pair moved the loan when it was made; an old row is inside the balance
    expect(wouldOverpayCents(owing, { ...pay, amountCents: 150_000 })).toBe(0);
    expect(wouldOverpayCents(owing, { ...pay, transferPeerId: 'leg' })).toBe(0);
    expect(wouldOverpayCents(owing, { ...pay, date: '2026-05-01' })).toBe(0);
    // the bank keeps a fetched loan's balance; a card and an ordinary account are no loan to overpay
    expect(wouldOverpayCents({ ...owing, source: 'connector' }, pay)).toBe(0);
    expect(wouldOverpayCents({ ...owing, type: 'credit' }, pay)).toBe(0);
    expect(wouldOverpayCents({ ...owing, type: 'savings' }, pay)).toBe(0);
  });
});

describe('#509: a loan typed at its original amount counts every payment linked to it', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  async function fresh() {
    const store = new DexieBackend(new MunniDB(`munni_pristine_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('pristine'), { trackOutbox: false });
    await repo.upsert('account', SPACE, 'main', { name: 'Checking', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 0 });
    return { store, repo };
  }

  const pay = (repo: Repo, id: string, date: string, amountCents: number) =>
    repo.upsert('transaction', SPACE, id, { accountId: 'main', date, amountCents, currency: 'EUR', merchant: 'Incasso lening', catId: 'loanRepayment', needsReview: 0 });
  const link = (repo: Repo, id: string) =>
    writeTxTransform(repo, { id, spaceId: SPACE, feedSpaceId: undefined, needsReview: 0 }, { linkedAccountId: 'loan' });

  it('pristine = the current balance IS the original amount', () => {
    expect(isPristineLoan({ originalCents: 10_000, balanceCents: -10_000 })).toBe(true);
    expect(isPristineLoan({ originalCents: 10_000, balanceCents: -9_000 })).toBe(false);
    expect(isPristineLoan({ originalCents: undefined, balanceCents: -10_000 })).toBe(false);
  });

  it('a pristine loan without a cut-off date: a payment from before its creation moves the balance', async () => {
    const { store, repo } = await fresh();
    await repo.upsert('account', SPACE, 'loan', { name: 'ING Loan 1', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -1_000_000, originalCents: 1_000_000 });
    await pay(repo, 'old', '2025-01-24', -6324);
    await link(repo, 'old');
    expect((await store.get('account', 'loan'))?.balanceCents).toBe(-993_676);
  });

  it('a loan created pristine before the rule settles: its uncounted payments count in and the date goes', async () => {
    const { store, repo } = await fresh();
    await repo.upsert('account', SPACE, 'loan', {
      name: 'ING Loan 1', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -1_000_000, originalCents: 1_000_000, balanceAsOf: '2026-10-01',
    });
    await pay(repo, 'p1', '2026-08-24', -6324);
    await pay(repo, 'p2', '2026-09-24', -6324);
    await link(repo, 'p1');
    await link(repo, 'p2');
    expect((await store.get('account', 'loan'))?.balanceCents).toBe(-1_000_000);

    expect(await settlePristineLoans(store, repo)).toBe(1);
    const loan = await store.get('account', 'loan');
    expect(loan?.balanceCents).toBe(-987_352);
    expect(loan?.balanceAsOf ?? undefined).toBeUndefined();
    expect((await store.get('transaction', 'p1'))?.loanCounted).toBe(1);
    expect(await settlePristineLoans(store, repo)).toBe(0);
    await writeTxTransform(repo, { id: 'p2', spaceId: SPACE, feedSpaceId: undefined, needsReview: 0 }, { linkedAccountId: null as never });
    expect((await store.get('account', 'loan'))?.balanceCents).toBe(-993_676);
  });

  it('a loan typed BELOW its original, or with a balance typed by hand, keeps its date', async () => {
    const { store, repo } = await fresh();
    await repo.upsert('account', SPACE, 'loan', {
      name: 'Half paid', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -500_000, originalCents: 1_000_000, balanceAsOf: '2026-10-01',
    });
    await pay(repo, 'p1', '2026-08-24', -6324);
    await link(repo, 'p1');
    await repo.upsert('account', SPACE, 'typed', {
      name: 'Typed', type: 'loan', source: 'manual', currency: 'EUR', balanceCents: -1_000_000, originalCents: 1_000_000, balanceAsOf: '2026-10-01',
    });
    await repo.upsert('transaction', SPACE, 'adj', {
      accountId: 'typed', date: '2026-10-01', amountCents: 500, currency: 'EUR', merchant: 'Balance adjustment', catId: 'balanceAdjustment', adjustment: 1, needsReview: 0,
    });
    expect(await settlePristineLoans(store, repo)).toBe(0);
    expect((await store.get('account', 'loan'))?.balanceAsOf).toBe('2026-10-01');
    expect((await store.get('account', 'typed'))?.balanceAsOf).toBe('2026-10-01');
  });
});
