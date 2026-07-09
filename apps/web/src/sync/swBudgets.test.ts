// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { HlcClock } from './hlc';
import { Repo } from '@/db/repo';
import { collectBudgetAlerts } from './swBudgets';

const DB = 'munni_test_budget_alerts';
const SPACE = 's1';

async function seed(db: MunniDB, opts: { spentCents: number; notifyAtPct: number }) {
  const repo = new Repo(db, new HlcClock('t'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('budget', SPACE, 'b1', {
    name: 'Groceries',
    amountCents: 10_000,
    every: 'month',
    anchor: '2026-01-01',
    catIds: ['groceries'],
    notifyAtPct: opts.notifyAtPct,
    active: 1,
  });
  await repo.upsert('transaction', SPACE, 't1', {
    accountId: 'a',
    date: new Date().toISOString().slice(0, 10),
    amountCents: -opts.spentCents,
    currency: 'EUR',
    merchant: 'AH',
    catId: 'groceries',
    txType: 'expense',
    needsReview: 0,
  });
}

describe('collectBudgetAlerts (budgets design P4)', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase(DB);
  });

  it('fires once per period when the threshold is crossed, localized', async () => {
    const db = new MunniDB(DB);
    await seed(db, { spentCents: 8500, notifyAtPct: 80 });

    const first = await collectBudgetAlerts(db, SPACE, 'en');
    expect(first).toHaveLength(1);
    expect(first[0].body).toBe('Groceries: 85% of the budget used');
    expect(first[0].url).toBe('./#/budgets/b1');

    // the marker holds — same period stays quiet
    expect(await collectBudgetAlerts(db, SPACE, 'en')).toHaveLength(0);
    db.close();
  });

  it('stays quiet below the threshold and without a configured threshold', async () => {
    const db = new MunniDB(DB);
    await seed(db, { spentCents: 5000, notifyAtPct: 80 });
    expect(await collectBudgetAlerts(db, SPACE, 'en')).toHaveLength(0);

    const repo = new Repo(db, new HlcClock('t2'), { trackOutbox: false });
    await repo.upsert('budget', SPACE, 'b1', { notifyAtPct: undefined });
    expect(await collectBudgetAlerts(db, SPACE, 'en')).toHaveLength(0);
    db.close();
  });

  it('over-budget wording carries the overshoot amount (dutch)', async () => {
    const db = new MunniDB(DB);
    await seed(db, { spentCents: 12_000, notifyAtPct: 100 });
    const alerts = await collectBudgetAlerts(db, SPACE, 'nl');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].body).toContain('Groceries is');
    expect(alerts[0].body).toContain('over het budget');
    expect(alerts[0].body).toMatch(/€\s?20/);
    db.close();
  });
});
