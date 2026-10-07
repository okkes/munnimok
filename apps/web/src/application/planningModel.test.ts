// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { mirroredSubjectId, planId } from '@/domain/planning';
import { availabilityByCat, buildPlanning, loadPlanningData, planOverspentCount, segmentsOf, sortSubjects } from './planningModel';

const SPACE = 's1';
const TODAY = '2026-03-15';

async function fixture() {
  const store = new DexieBackend(new MunniDB(`munni_plan_${Math.random().toString(36).slice(2)}`));
  const repo = new Repo(store, new HlcClock('plan'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 200_000, source: 'manual' });
  await repo.upsert('account', SPACE, 'cash', { name: 'Wallet', type: 'cash', currency: 'EUR', balanceCents: 5_000, source: 'manual' });
  await repo.upsert('account', SPACE, 'save', { name: 'Savings', type: 'savings', currency: 'EUR', balanceCents: 900_000, source: 'manual' });
  await repo.upsert('recurring', SPACE, 'rent', { name: 'Rent', kind: 'fixed', amountCents: 100_000, catId: 'housingRent', every: 'month', dueDay: 1, active: 1 });
  const tx = (id: string, date: string, amountCents: number, catId: string, extra: Record<string, unknown> = {}) =>
    repo.upsert('transaction', SPACE, id, { accountId: 'main', date, amountCents, currency: 'EUR', merchant: 'x', catId, needsReview: 0, ...extra });
  await tx('g1', '2026-03-03', -6_000, 'groceries');
  await tx('g2', '2026-03-10', -5_000, 'groceries');
  await tx('g0', '2026-02-10', -9_000, 'groceries');
  await tx('r1', '2026-03-01', -100_000, 'housingRent', { recurringId: 'rent' });
  await tx('r0', '2026-02-01', -100_000, 'housingRent', { recurringId: 'rent' });
  return { store, repo };
}

const march = planId(SPACE, 'actual', '2026-03-01');
const february = planId(SPACE, 'actual', '2026-02-01');
const april = planId(SPACE, 'actual', '2026-04-01');

describe('planning model (#128)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('the pool is the checking and cash money; what is left is the pool minus what the plans still hold (funding net of spending), ahead included', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: march, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 10_000 });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'recurring', 'rent'), { planId: march, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 100_000 });
    await repo.upsert('plan', SPACE, april, { kind: 'actual', periodStart: '2026-04-01' });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(april, 'recurring', 'rent'), { planId: april, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 50_000 });

    const model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.poolCents).toBe(205_000);
    expect(model.plan?.id).toBe(march);
    // March holds nothing any more: groceries spent its 10k (and 1k over), the rent was paid — only April's 50k is held
    expect(model.toAllocateOf(model.plan!)).toBe(205_000 - 50_000);
    // a period ahead never counts its own funding twice
    expect(model.toAllocateOf(model.ahead[0].plan)).toBe(205_000 - 50_000);
    expect(model.ahead).toHaveLength(1);
    expect(model.aheadCount).toBeCloseTo(0.5, 5);
    expect(model.nextAheadPeriod.start).toBe('2026-05-01');
    expect(model.aheadSuggested).toBe(3);

    const views = model.viewsOf(model.plan!);
    const groceries = views.find((v) => v.subject.id === 'gro')!;
    expect(groceries.realizedCents).toBe(11_000);
    expect(groceries.status).toBe('overspent');
    expect(model.attention.map((v) => v.subject.name)).toEqual(['Groceries']);
    // reserved: nothing left unspent in March (10k funded, 11k spent; rent paid) + 50k ahead
    expect(model.reservedCents).toBe(50_000);
    expect(model.estimate(new Set(['groceries'])).lastCents).toBe(9_000);
    expect(await planOverspentCount(store, SPACE)).toBe(0); // the real today has no plan in this fixture
  });

  it('what an earlier period set aside and never spent carries into the next one', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    // February funded the rent twice over and paid it once → 100k carries into March
    await repo.upsert('plan', SPACE, february, { kind: 'actual', periodStart: '2026-02-01' });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(february, 'recurring', 'rent'), { planId: february, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 200_000 });
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'recurring', 'rent'), { planId: march, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 0 });

    const model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    const rent = model.viewsOf(model.plan!)[0];
    expect(rent.carriedCents).toBe(100_000);
    expect(rent.targetCents).toBe(0);
    expect(model.previousPlan?.id).toBe(february);
    expect(model.editabilityOf(model.previousPlan!)).toBe('moveOnly');
    expect(model.editabilityOf(model.plan!)).toBe('full');
  });

  it('segments keep their saved order with the rest appended; the picker reads the subject behind a category', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01', segments: [{ kind: 'goals' }, { kind: 'expenses' }, { kind: 'budgets', hidden: 1 }] });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: march, segment: 'expenses', order: 1, name: 'Groceries', catIds: ['consumption'], excludeCatIds: ['coffee'], targetCents: 15_000, fundedCents: 20_000 });
    await repo.upsert('planSubject', SPACE, 'r', { planId: march, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 0 });

    expect(segmentsOf({ segments: [{ kind: 'goals' }, { kind: 'expenses' }, { kind: 'budgets', hidden: 1 }] }).map((s) => s.kind)).toEqual(['goals', 'expenses', 'budgets', 'recurring', 'debts']);
    const model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(sortSubjects(model.subjectsOf(model.plan!), model.segmentsOf(model.plan!)).map((s) => s.id)).toEqual(['gro', 'r']);
    const availability = availabilityByCat(model);
    expect(availability.get('groceries')).toMatchObject({ subjectName: 'Groceries', cents: 20_000 - 11_000 });
    expect(availability.has('coffee')).toBe(false);
  });
});
