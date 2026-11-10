// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { byBirth, mirroredSubjectId, planId } from '@/domain/planning';
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
  return { store, repo, ops: buildOps(store, repo, SPACE, TODAY) };
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

    // Start over tombstones the row — and the plan with it, so the start screen comes back (#557);
    // the deterministic ids mean starting again and adding the source revives those very rows
    await ops.clearPlan((await modelOf(store)).plan!);
    expect((await store.get('planSubject', id))?.deleted).toBe(1);
    expect((await modelOf(store)).plan).toBeNull();
    await ops.startPlan(MARCH, { kind: 'empty' });
    await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent' });
    const revived = await store.get('planSubject', id);
    // every field written anew: the skip and the funding did not come back, nor the face it no longer has
    expect(revived).toMatchObject({ deleted: 0, snoozed: 0, fundedCents: 0, name: 'Rent', sourceId: 'rent', segment: 'recurring', order: 0 });
    expect(revived?.icon ?? null).toBeNull();
    expect(revived?.catIds ?? null).toBeNull();
    expect(revived?.targetCents ?? null).toBeNull();
  });

  it('a plan started again from a blueprint revives a tombstoned twin clean too', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    const id = await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent' });
    const saved = await ops.saveBlueprint((await modelOf(store)).plan!, 'Normal');
    expect(saved.ok).toBe(true);
    await ops.snooze(id, true);
    await ops.fund(id, 10_000);
    await ops.clearPlan((await modelOf(store)).plan!);
    await ops.startPlan(MARCH, { kind: 'blueprint', id: (saved as { id: string }).id });
    expect(await store.get('planSubject', id)).toMatchObject({ deleted: 0, snoozed: 0, fundedCents: 0, sourceId: 'rent' });
  });

  it('a new period carries the last plan over: the subjects that still matter, unfunded, in the order they came into the plan — and only once (#557)', async () => {
    const { store, repo, ops } = await fixture();
    stores.push(store);
    const feb = planId(SPACE, 'actual', '2026-02-01');
    await repo.upsert('plan', SPACE, feb, { kind: 'actual', periodStart: '2026-02-01', segments: [{ kind: 'goals' }] });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: feb, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 9_000 });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(feb, 'recurring', 'rent'), { planId: feb, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 100_000 });
    // a party that was over in February stays behind
    await repo.upsert('event', SPACE, 'party', { name: 'Party', from: '2026-02-10', to: '2026-02-11', budgetCents: 5_000 });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(feb, 'events', 'party'), { planId: feb, segment: 'events', order: 0, name: 'Party', sourceId: 'party', fundedCents: 5_000 });

    expect(await ops.continuePlan()).toBe(true);
    const model = await modelOf(store);
    expect(model.plan?.id).toBe(march);
    expect(model.plan?.segments).toEqual([{ kind: 'goals' }]);
    const carried = model.subjectsOf(model.plan!);
    expect(carried.map((s) => s.name).sort((a, b) => a.localeCompare(b))).toEqual(['Groceries', 'Rent']);
    expect(carried.every((s) => s.fundedCents === 0)).toBe(true);
    expect(carried.find((s) => s.name === 'Groceries')).toMatchObject({ id: `psub:${march}:expenses:gro`, targetCents: 15_000 });
    expect(byBirth(carried).map((s) => s.name)).toEqual(['Groceries', 'Rent']);
    // a second look: nothing more happens
    expect(await ops.continuePlan()).toBe(false);
    expect((await modelOf(store)).subjectsOf(model.plan!)).toHaveLength(2);
  });

  it('after a period without a plan the newest plan before it carries over, on the rows a carry-over a period earlier would have led to (#557)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    const feb = planId(SPACE, 'actual', '2026-02-01');
    const april = planId(SPACE, 'actual', '2026-04-01');
    await repo.upsert('plan', SPACE, feb, { kind: 'actual', periodStart: '2026-02-01' });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: feb, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 9_000 });
    const inApril = buildOps(store, repo, SPACE, '2026-04-15');
    expect(await inApril.continuePlan()).toBe(true);
    const model = buildPlanning(await loadPlanningData(store, SPACE), '2026-04-15');
    expect(model.plan?.id).toBe(april);
    expect(model.subjectsOf(model.plan!).map((s) => [s.id, s.name, s.fundedCents])).toEqual([[`psub:${april}:expenses:gro`, 'Groceries', 0]]);
  });

  it('Start over goes back to the start screen: the plan, its subjects, its one-offs and its sandbox go; the period does not carry over again (#557)', async () => {
    const { store, repo, ops } = await fixture();
    stores.push(store);
    const feb = planId(SPACE, 'actual', '2026-02-01');
    await repo.upsert('plan', SPACE, feb, { kind: 'actual', periodStart: '2026-02-01' });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: feb, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 0 });
    await ops.continuePlan();
    let model = await modelOf(store);
    await ops.fundOneOff(model.plan!, 'recurring:rent', 50_000);
    await ops.createSandbox();
    model = await modelOf(store);
    expect(model.sandbox?.oneOffs).toEqual([{ key: 'recurring:rent', fundedCents: 50_000 }]);

    await ops.clearPlan(model.plan!);
    model = await modelOf(store);
    expect(model.plan).toBeNull();
    expect(model.sandbox).toBeNull();
    expect(model.continuable).toBe(false);
    expect(await ops.continuePlan()).toBe(false);
    // starting again revives the row clean: no one-off comes back
    await ops.startPlan(MARCH, { kind: 'empty' });
    model = await modelOf(store);
    expect(model.plan?.oneOffs).toEqual([]);
    expect(model.subjectsOf(model.plan!)).toEqual([]);
  });

  it('a one-off funds an Unplanned row for this period only; planning the row takes the money along, Take all back clears it, no copy carries it (#494)', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    let model = await modelOf(store);
    const started = model.startedWithOf(model.plan!);
    await ops.fundOneOff(model.plan!, 'recurring:rent', 100_000);
    model = await modelOf(store);
    expect(model.unplannedOf(model.plan!)[0]).toMatchObject({ kind: 'recurring', cents: 100_000, fundedCents: 100_000 });
    expect(model.toAllocateOf(model.plan!)).toBe(started - 100_000);
    // a period ahead and a blueprint take the plan's shape — never its one-offs
    await ops.fundAhead(model.nextAheadPeriod);
    const saved = await ops.saveBlueprint(model.plan!, 'Normal');
    model = await modelOf(store);
    expect(model.ahead[0].plan.oneOffs).toEqual([]);
    expect(model.blueprints.find((b) => b.id === (saved as { id: string }).id)?.oneOffs).toBeUndefined();

    // Plan it: the subject is born with the money the row had
    const id = await ops.addMirrored(march, 'recurring', { id: 'rent', name: 'Rent' });
    model = await modelOf(store);
    expect(model.plan?.oneOffs).toEqual([]);
    expect(model.viewsOf(model.plan!).find((v) => v.subject.id === id)).toMatchObject({ fundedCents: 100_000, status: 'funded' });
    expect(model.toAllocateOf(model.plan!)).toBe(started - 100_000);

    // 0 takes a one-off back; Take all back empties them all
    await ops.fundOneOff(model.plan!, 'goal:x', 3_000);
    await ops.withdrawAll((await modelOf(store)).plan!);
    expect((await modelOf(store)).plan?.oneOffs).toEqual([]);
  });

  it('applying this plan to the periods ahead keeps what a subject already holds there, an expense subject’s too', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    // categories in the order they were ticked, not the alphabet's
    await ops.addExpense(march, { name: 'Food', catIds: ['groceries', 'coffee'], targetCents: 15_000 });
    await ops.fundAhead((await modelOf(store)).nextAheadPeriod);
    let model = await modelOf(store);
    const [food] = model.subjectsOf(model.ahead[0].plan);
    expect(food).toMatchObject({ name: 'Food', fundedCents: 15_000 });

    await ops.addExpense(march, { name: 'Fun', catIds: ['entertainment'], targetCents: 5_000 });
    await ops.applyToAhead((await modelOf(store)).plan!);
    model = await modelOf(store);
    expect(model.subjectsOf(model.ahead[0].plan).map((s) => [s.name, s.fundedCents])).toEqual([['Food', 15_000], ['Fun', 0]]);
    expect(model.subjectsOf(model.ahead[0].plan)[0].id).toBe(food.id);

    // the sandbox finds its twin the same way
    const current = model.subjectsOf(model.plan!).find((s) => s.name === 'Food')!;
    await ops.fund(current.id, 12_000);
    await ops.createSandbox();
    model = await modelOf(store);
    expect(model.subjectsOf(model.sandbox!).find((s) => s.name === 'Food')?.fundedCents).toBe(12_000);
  });

  it('freeing categories takes them from the holder; a subject left with none goes, its money back to the pool (#535)', async () => {
    const { store, ops } = await fixture();
    stores.push(store);
    await ops.startPlan(MARCH, { kind: 'empty' });
    const both = await ops.addExpense(march, { name: 'Food', catIds: ['groceries', 'coffee'], targetCents: 10_000 });
    const one = await ops.addExpense(march, { name: 'Coffee', catIds: ['coffee'], targetCents: 1_000 });
    await ops.freeCategories(both, ['groceries']);
    expect(await store.get('planSubject', both)).toMatchObject({ deleted: 0, catIds: ['coffee'] });
    await ops.freeCategories(one, ['coffee']);
    expect((await store.get('planSubject', one))?.deleted).toBe(1);
  });

  it('an event subject takes the person’s own total, and empty goes back to the estimate (#504)', async () => {
    const { store, repo, ops } = await fixture();
    stores.push(store);
    await repo.upsert('event', SPACE, 'trip', { name: 'Trip', from: '2026-05-10', budgetCents: 60_000 });
    await ops.startPlan(MARCH, { kind: 'empty' });
    const id = await ops.addMirrored(march, 'events', { id: 'trip', name: 'Trip' });
    const target = async () => (await modelOf(store)).viewsOf((await modelOf(store)).plan!).find((v) => v.subject.id === id)?.targetCents;
    expect(await target()).toBe(20_000);
    await ops.setOwnTarget(id, 90_000);
    expect(await target()).toBe(30_000);
    await ops.setOwnTarget(id, null);
    expect(await target()).toBe(20_000);
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
