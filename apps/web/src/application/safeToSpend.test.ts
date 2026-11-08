// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { mirroredSubjectId, planId } from '@/domain/planning';
import { HlcClock } from '@/sync/hlc';
import { buildPlanning, loadPlanningData } from './planningModel';
import { buildSafeToSpendOps, planHeld } from './safeToSpend';

const SPACE = 's1';
const TODAY = '2026-03-10';
const dbs: MunniDB[] = [];

async function fixture() {
  const db = new MunniDB(`munni_spend_${dbs.length}_${Date.now()}`);
  dbs.push(db);
  const store = new DexieBackend(db);
  const repo = new Repo(store, new HlcClock('spend'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'Home', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', source: 'manual', currency: 'EUR', balanceCents: 200_000 });
  return { store, repo };
}

afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

describe('safe to spend settings (#541)', () => {
  it('the accounts and the set-asides are space fields, each change in the activity log', async () => {
    const { store, repo } = await fixture();
    const ops = buildSafeToSpendOps(store, repo, SPACE);

    await ops.setAccounts(['main', 'card']);
    expect((await store.get('space', SPACE))?.spendAccountIds).toEqual(['main', 'card']);
    // back to the default: null, which travels to the server (an undefined field would not)
    await ops.setAccounts(null);
    expect((await store.get('space', SPACE))?.spendAccountIds).toBeNull();

    await ops.toggleSetAside('goals');
    await ops.toggleSetAside('events');
    await ops.toggleSetAside('goals');
    expect((await store.get('space', SPACE))?.spendSetAsides).toEqual(['events']);

    const kinds = (await store.bySpace('activity', SPACE)).filter((r) => r.deleted === 0).map((r) => r.kind);
    expect(kinds).toEqual(['spendEdit', 'spendEdit', 'spendEdit', 'spendEdit', 'spendEdit']);
  });

  it('reads what the plan still holds per set-aside — nothing to offer while the space plans nothing', async () => {
    const { store, repo } = await fixture();
    expect(planHeld(undefined)).toBeNull();
    expect(planHeld(buildPlanning(await loadPlanningData(store, SPACE), TODAY))).toBeNull();

    const march = planId(SPACE, 'actual', '2026-03-01');
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    await repo.upsert('goal', SPACE, 'trip', { name: 'Trip', targetCents: 300_000 });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'goals', 'trip'), { planId: march, segment: 'goals', order: 0, name: 'Trip', sourceId: 'trip', fundedCents: 25_000 });
    await repo.upsert('planSubject', SPACE, 'food', { planId: march, segment: 'expenses', order: 0, name: 'Food', catIds: ['groceries'], targetCents: 40_000, fundedCents: 40_000 });
    await repo.upsert('transaction', SPACE, 'g1', { accountId: 'main', date: '2026-03-04', amountCents: -15_000, currency: 'EUR', merchant: 'Shop', catId: 'groceries', needsReview: 0 });
    const april = planId(SPACE, 'actual', '2026-04-01');
    await repo.upsert('plan', SPACE, april, { kind: 'actual', periodStart: '2026-04-01' });
    await repo.upsert('planSubject', SPACE, 'food-apr', { planId: april, segment: 'expenses', order: 0, name: 'Food', catIds: ['groceries'], fundedCents: 30_000 });

    // the trip keeps its 250, the food what it did not spend yet; April's 300 is funded ahead
    expect(planHeld(buildPlanning(await loadPlanningData(store, SPACE), TODAY))).toEqual({
      goals: 25_000,
      events: 0,
      expenses: 25_000,
      budgets: 0,
      ahead: 30_000,
    });
  });
});
