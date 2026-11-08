// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { writeTxTransform } from '@/db/joined';
import { applyLoanLinkDelta, countPreAnchorTx, countsTowardLoan, isPristineLoan, settlePristineLoans } from './loanBalance';

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
    // borrowing €50 more THROUGH the loan pushes the debt deeper
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
    // the loanCounted override rides the same check
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
    // the marker makes a second call a no-op
    const again = await countPreAnchorTx(store, repo, { ...tx, loanCounted: 1 } as never, async () => undefined);
    expect(again).toBe(false);
    expect((await store.get('account', 'loan1'))?.balanceCents).toBe(-40_000);
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
    // the cut-off kept both out
    expect((await store.get('account', 'loan'))?.balanceCents).toBe(-1_000_000);

    expect(await settlePristineLoans(store, repo)).toBe(1);
    const loan = await store.get('account', 'loan');
    expect(loan?.balanceCents).toBe(-987_352);
    expect(loan?.balanceAsOf ?? undefined).toBeUndefined();
    expect((await store.get('transaction', 'p1'))?.loanCounted).toBe(1);
    // settled once: nothing left to fold
    expect(await settlePristineLoans(store, repo)).toBe(0);
    // and unlinking now gives the payment back
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
