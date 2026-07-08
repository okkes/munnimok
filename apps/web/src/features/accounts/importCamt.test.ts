import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HlcClock } from '@/sync/hlc';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
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
    const grocery = txs.find((t) => t.importRef === 'REF-001')!;
    expect(grocery).toMatchObject({ catId: 'groceries', needsReview: 0, txType: 'expense' });
    const salary = txs.find((t) => t.importRef === 'REF-002')!;
    expect(salary).toMatchObject({ catId: 'salary', needsReview: 0, txType: 'income' });
    const unknown = txs.find((t) => t.importRef === 'REF-003')!;
    expect(unknown).toMatchObject({ catId: 'uncategorized', needsReview: 1 });
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
