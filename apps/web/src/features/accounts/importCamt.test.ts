import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { feedSpaceId } from '@/domain/feedIds';
import { visibleTransactions } from '@/db/joined';
import type { CamtStatement } from '@/lib/camt053/parse';
import { importCamtStatements } from './importCamt';

let counter = 0;

const statement = (overrides: Partial<CamtStatement> = {}): CamtStatement => ({
  iban: 'NL69INGB0123456789',
  currency: 'EUR',
  closingBalanceCents: 123456,
  entries: [
    {
      amountCents: -4210,
      currency: 'EUR',
      date: '2026-07-05',
      counterpartyName: 'Albert Heijn 1350',
      description: 'AH 1350 AMSTERDAM',
      ref: 'REF-001',
    },
    {
      amountCents: 220000,
      currency: 'EUR',
      date: '2026-06-25',
      counterpartyName: 'Werkgever BV',
      description: 'SALARIS JUNI',
      ref: 'REF-002',
    },
    {
      amountCents: -999,
      currency: 'EUR',
      date: '2026-06-24',
      counterpartyName: 'Onbekend XQZ',
      description: 'QWERTY',
      ref: 'REF-003',
    },
  ],
  ...overrides,
});

describe('importCamtStatements', () => {
  let db: MunniDB;
  let repo: Repo;
  let wall = 1_000_000;

  beforeEach(() => {
    db = new MunniDB(`camt_test_${++counter}`);
    repo = new Repo(db, new HlcClock('dev', undefined, () => ++wall), { trackOutbox: false });
  });
  afterEach(async () => db.delete());

  it('creates an account from an unknown IBAN and imports categorized txs', async () => {
    const result = await importCamtStatements(repo, db, 's1', [statement()]);
    expect(result).toMatchObject({ imported: 3, skipped: 0 });
    expect(result.accounts[0]).toMatchObject({ isNew: true, txCount: 3 });

    const account = await db.accounts.get(result.accounts[0].accountId);
    expect(account).toMatchObject({ source: 'camt053', balanceCents: 123456, currency: 'EUR' });

    const txs = await db.transactions.toArray();
    expect(txs).toHaveLength(3);
    // keyword predictions are guesses: applied, but flagged for review —
    // only merchant history the user confirmed twice skips the queue
    const grocery = txs.find((t) => t.importRef === 'REF-001')!;
    expect(grocery).toMatchObject({ catId: 'groceries', needsReview: 1, txType: 'expense' });
    const salary = txs.find((t) => t.importRef === 'REF-002')!;
    expect(salary).toMatchObject({ catId: 'salary', needsReview: 1, txType: 'income' });
    const unknown = txs.find((t) => t.importRef === 'REF-003')!;
    expect(unknown).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
  });

  it('twice-confirmed merchant history overrides keywords and skips review', async () => {
    await repo.upsert('space', 's1', 's1', { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    // the user categorized this merchant twice by hand (reviewed rows)
    for (const [id, date] of [['h1', '2026-05-01'], ['h2', '2026-06-01']] as const) {
      await repo.upsert('transaction', 's1', id, {
        accountId: 'acct-x',
        date,
        amountCents: -1500,
        currency: 'EUR',
        merchant: 'Albert Heijn 1470',
        catId: 'sport',
        txType: 'expense',
        needsReview: 0,
      });
    }
    await importCamtStatements(repo, db, 's1', [statement()]);
    // REF-001 is an Albert Heijn debit: history (sport) beats the
    // groceries keyword, and two confirmations mean no review
    const tx = (await db.transactions.toArray()).find((t) => t.importRef === 'REF-001')!;
    expect(tx).toMatchObject({ catId: 'sport', needsReview: 0 });
  });

  it('matches an existing account by IBAN (spacing/case-insensitive) and updates its balance', async () => {
    await repo.upsert('account', 's1', 'acct-existing', {
      name: 'Mijn ING',
      type: 'checking',
      source: 'manual',
      currency: 'EUR',
      balanceCents: 1,
      iban: 'nl69 ingb 0123 4567 89',
    });
    const result = await importCamtStatements(repo, db, 's1', [statement()]);
    expect(result.accounts[0]).toMatchObject({ accountId: 'acct-existing', isNew: false });
    expect((await db.accounts.get('acct-existing'))!.balanceCents).toBe(123456);
    expect((await db.accounts.count())).toBe(1); // no duplicate account
  });

  it('re-import skips every already-imported transaction', async () => {
    await importCamtStatements(repo, db, 's1', [statement()]);
    const again = await importCamtStatements(repo, db, 's1', [statement()]);
    expect(again).toMatchObject({ imported: 0, skipped: 3 });
    expect(await db.transactions.count()).toBe(3);
  });

  it('null closing balance leaves an existing balance untouched', async () => {
    await importCamtStatements(repo, db, 's1', [statement()]);
    const accountId = (await db.accounts.toArray())[0].id;
    await importCamtStatements(repo, db, 's1', [
      statement({ closingBalanceCents: null, entries: [] }),
    ]);
    expect((await db.accounts.get(accountId))!.balanceCents).toBe(123456);
  });

  it('a dated statement balance overwrites only when it is not older', async () => {
    await importCamtStatements(repo, db, 's1', [
      statement({ closingBalanceCents: 5000, balanceAsOf: '2026-07-05', entries: [] }),
    ]);
    const accountId = (await db.accounts.toArray())[0].id;
    expect((await db.accounts.get(accountId))!).toMatchObject({ balanceCents: 5000, balanceAsOf: '2026-07-05' });

    // an OLDER statement (re-importing last month's file) must not regress the balance
    await importCamtStatements(repo, db, 's1', [
      statement({ closingBalanceCents: 1111, balanceAsOf: '2026-06-01', entries: [] }),
    ]);
    expect((await db.accounts.get(accountId))!).toMatchObject({ balanceCents: 5000, balanceAsOf: '2026-07-05' });

    // a newer one wins
    await importCamtStatements(repo, db, 's1', [
      statement({ closingBalanceCents: 7777, balanceAsOf: '2026-07-06', entries: [] }),
    ]);
    expect((await db.accounts.get(accountId))!).toMatchObject({ balanceCents: 7777, balanceAsOf: '2026-07-06' });
  });

  it('a dated statement balance beats an undated manual one (unknown age loses to bank truth)', async () => {
    await repo.upsert('account', 's1', 'acct-manual', {
      name: 'Mijn ING',
      type: 'checking',
      source: 'manual',
      currency: 'EUR',
      balanceCents: 42,
      iban: 'NL69INGB0123456789',
    });
    await importCamtStatements(repo, db, 's1', [
      statement({ closingBalanceCents: 9000, balanceAsOf: '2026-07-01', entries: [] }),
    ]);
    expect((await db.accounts.get('acct-manual'))!).toMatchObject({ balanceCents: 9000, balanceAsOf: '2026-07-01' });
  });

  it('with a feed gateway: raw goes to the feed, overlay + link to the space (idempotent)', async () => {
    const registered: string[] = [];
    const attached: string[] = [];
    const gateway = {
      register: async (id: string) => {
        registered.push(id);
        return id;
      },
      attach: async (spaceId: string, feedId: string, accountId: string) => {
        attached.push(`${spaceId}:${feedId}:${accountId}`);
      },
    };

    const result = await importCamtStatements(repo, db, 's1', [statement()], gateway);
    expect(result.imported).toBe(3);
    const feedId = registered[0];
    expect(feedId).toBe(feedSpaceId('NL69INGB0123456789'));

    // raw halves live in the feed space, carrying no opinion
    const raw = await db.transactions.where('spaceId').equals(feedId).toArray();
    expect(raw).toHaveLength(3);
    expect(raw.every((tx) => tx.catId === undefined && tx.needsReview === undefined)).toBe(true);
    expect(await db.transactions.where('spaceId').equals('s1').count()).toBe(0);

    // the space holds the predicted overlay + the attachment mirror
    const metas = await db.txMeta.where('spaceId').equals('s1').toArray();
    expect(metas).toHaveLength(3);
    expect(metas.some((m) => m.catId !== undefined)).toBe(true); // salary/groceries predicted
    expect(await db.accountLinks.where('spaceId').equals('s1').count()).toBe(1);
    expect(attached).toHaveLength(1);

    // the account row sits in the feed with the dated balance
    const account = (await db.accounts.toArray())[0];
    expect(account.spaceId).toBe(feedId);
    expect(account.balanceCents).toBe(123456);

    // …and the join layer serves it all back to the space
    const visible = await visibleTransactions(db, 's1');
    expect(visible).toHaveLength(3);
    expect(visible.every((tx) => tx.feedSpaceId === feedId)).toBe(true);

    // re-import: everything skips, nothing duplicates
    const again = await importCamtStatements(repo, db, 's1', [statement()], gateway);
    expect(again).toMatchObject({ imported: 0, skipped: 3 });
    expect(await db.transactions.count()).toBe(3);
    expect(await db.txMeta.count()).toBe(3);
  });

  it('a manual balance dated after the statement is kept', async () => {
    await repo.upsert('account', 's1', 'acct-manual', {
      name: 'Mijn ING',
      type: 'checking',
      source: 'manual',
      currency: 'EUR',
      balanceCents: 42,
      balanceAsOf: '2026-07-08', // user corrected it today
      iban: 'NL69INGB0123456789',
    });
    await importCamtStatements(repo, db, 's1', [
      statement({ closingBalanceCents: 9000, balanceAsOf: '2026-07-01', entries: [] }),
    ]);
    expect((await db.accounts.get('acct-manual'))!).toMatchObject({ balanceCents: 42, balanceAsOf: '2026-07-08' });
  });
});
