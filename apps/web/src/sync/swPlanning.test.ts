// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { MunniDB } from '@/db/schema';
import { HlcClock } from './hlc';
import { Repo } from '@/db/repo';
import { DexieBackend } from '@/db/backend';
import { readInbox } from '@/application/notifications';
import { planId } from '@/domain/planning';
import { collectPlanAlerts } from './swPlanning';

const DB = 'munni_test_plan_alerts';
const SPACE = 's1';

const localIso = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = () => `${localIso().slice(0, 7)}-01`;

/** a plan whose groceries subject holds less than it spent */
async function seed(db: MunniDB, opts: { fundedCents: number; spentCents: number }) {
  const repo = new Repo(new DexieBackend(db), new HlcClock('t'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'a', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 100_000, source: 'manual' });
  const plan = planId(SPACE, 'actual', monthStart());
  await repo.upsert('plan', SPACE, plan, { kind: 'actual', periodStart: monthStart() });
  await repo.upsert('planSubject', SPACE, 'sub1', { planId: plan, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 10_000, fundedCents: opts.fundedCents });
  await repo.upsert('transaction', SPACE, 't1', {
    accountId: 'a',
    date: localIso(),
    amountCents: -opts.spentCents,
    currency: 'EUR',
    merchant: 'AH',
    catId: 'groceries',
    needsReview: 0,
  });
}

describe('collectPlanAlerts (#128)', () => {
  beforeEach(() => {
    indexedDB.deleteDatabase(DB);
  });

  it('a subject in the red is told once a day — inbox row and OS alert', async () => {
    const db = new MunniDB(DB);
    await seed(db, { fundedCents: 5_000, spentCents: 8_000 });
    const store = new DexieBackend(db);
    const first = await collectPlanAlerts(store, SPACE, 'en');
    expect(first).toHaveLength(1);
    expect(first[0].body).toContain('Groceries');
    expect(first[0].url).toBe('./#/planning');
    const inbox = await readInbox(store);
    expect(inbox[0]).toMatchObject({ kind: 'planOverspent', payload: expect.objectContaining({ names: 'Groceries', n: '1' }) });
    // the same day never hears it twice
    expect(await collectPlanAlerts(store, SPACE, 'en')).toEqual([]);
    expect(await readInbox(store)).toHaveLength(1);
    db.close();
  });

  it('a funded subject and a space without a plan stay quiet', async () => {
    const db = new MunniDB(DB);
    await seed(db, { fundedCents: 9_000, spentCents: 8_000 });
    const store = new DexieBackend(db);
    expect(await collectPlanAlerts(store, SPACE, 'nl')).toEqual([]);
    expect(await collectPlanAlerts(store, 'other-space', 'nl')).toEqual([]);
    expect(await readInbox(store)).toHaveLength(0);
    db.close();
  });
});
