// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { mirroredSubjectId, planId } from '@/domain/planning';
import { buildOps } from './planning';
import { buildPlanning, loadPlanningData } from './planningModel';

const SPACE = 's1';
const TODAY = '2026-03-15';
const MARCH = { start: '2026-03-01', end: '2026-03-31' };
const march = planId(SPACE, 'actual', MARCH.start);

/** a checking account, a monthly rent and the rent paid in March (planningModel.test's fixture, trimmed) */
async function fixture() {
  const store = new DexieBackend(new MunniDB(`munni_ops_${Math.random().toString(36).slice(2)}`));
  const repo = new Repo(store, new HlcClock('ops'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 200_000, source: 'manual' });
  await repo.upsert('recurring', SPACE, 'rent', { name: 'Rent', kind: 'fixed', amountCents: 100_000, catId: 'housingRent', every: 'month', dueDay: 1, active: 1, icon: 'home-outline' });
  await repo.upsert('transaction', SPACE, 'r1', { accountId: 'main', date: '2026-03-01', amountCents: -100_000, currency: 'EUR', merchant: 'landlord', catId: 'housingRent', needsReview: 0, recurringId: 'rent' });
  return { store, repo, ops: buildOps(store, repo, SPACE) };
}

const modelOf = async (store: DexieBackend) => buildPlanning(await loadPlanningData(store, SPACE), TODAY);

describe('planning ops (#128)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('a mirrored subject removed by Start over and added again starts clean: not skipped, nothing funded (user 2026-10-09)', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    const id = await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent', icon: 'home-outline' });
    expect(id).toBe(mirroredSubjectId(march, 'recurring', 'rent'));
    await ops.fund(id, 50_000);
    await ops.snooze(id, true);
    expect(await store.get('planSubject', id)).toMatchObject({ snoozed: 1, fundedCents: 50_000, icon: 'home-outline', deleted: 0 });

    // Start over tombstones the row; the deterministic id means the next add revives that very row
    await ops.clearPlan((await modelOf(store)).plan!);
    expect((await store.get('planSubject', id))?.deleted).toBe(1);
    await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent' });
    const revived = await store.get('planSubject', id);
    // every field written anew: the skip and the funding did not come back, nor the face it no longer has
    expect(revived).toMatchObject({ deleted: 0, snoozed: 0, fundedCents: 0, name: 'Rent', sourceId: 'rent', segment: 'recurring', order: 0 });
    expect(revived?.icon ?? null).toBeNull();
    expect(revived?.catIds ?? null).toBeNull();
    expect(revived?.targetCents ?? null).toBeNull();
  });

  it('a blueprint applied over a tombstoned twin revives it clean too', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    const id = await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent' });
    const saved = await ops.saveBlueprint((await modelOf(store)).plan!, 'Normal');
    expect(saved.ok).toBe(true);
    await ops.snooze(id, true);
    await ops.fund(id, 10_000);
    await ops.clearPlan((await modelOf(store)).plan!);
    await ops.applyBlueprint((saved as { id: string }).id, (await modelOf(store)).plan!, false);
    expect(await store.get('planSubject', id)).toMatchObject({ deleted: 0, snoozed: 0, fundedCents: 0, sourceId: 'rent' });
  });

  it('planning a paid recurring cost from Unplanned moves its money into the subject: the head does not move', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    let model = await modelOf(store);
    expect(model.unplannedOf(model.plan!).map((r) => [r.kind, r.cents])).toEqual([['recurring', 100_000]]);
    const started = model.startedWithOf(model.plan!);
    expect(started).toBe(200_000 + 100_000);

    await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent' });
    model = await modelOf(store);
    expect(model.unplannedOf(model.plan!)).toEqual([]);
    expect(model.viewsOf(model.plan!)[0]).toMatchObject({ realizedCents: 100_000, fundedCents: 0, status: 'overspent' });
    expect(model.startedWithOf(model.plan!)).toBe(started);
    expect(model.toAllocateOf(model.plan!)).toBe(started);
  });
});
