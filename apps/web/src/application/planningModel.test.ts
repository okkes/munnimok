// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { mirroredSubjectId, planId, unplannedKey } from '@/domain/planning';
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

const tx = (repo: Repo, id: string, date: string, amountCents: number, catId: string) =>
  repo.upsert('transaction', SPACE, id, { accountId: 'main', date, amountCents, currency: 'EUR', merchant: 'x', catId, needsReview: 0 });

/** the user's own example (2026-10-08): a €1,500 balance, €1,000 of it spent this period on nothing planned */
async function bareFixture() {
  const store = new DexieBackend(new MunniDB(`munni_plan_${Math.random().toString(36).slice(2)}`));
  const repo = new Repo(store, new HlcClock('plan'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 150_000, source: 'manual' });
  await repo.upsert('recurring', SPACE, 'rent', { name: 'Rent', kind: 'fixed', amountCents: 100_000, catId: 'housingRent', every: 'month', dueDay: 1, active: 1 });
  await tx(repo, 'c1', '2026-03-05', -100_000, 'coffee');
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

  it('the pool is the checking and cash money; what is left is what the period started with minus the subjects’ funding, ahead included', async () => {
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
    // what March started with: the balance plus what it spent — groceries 11k and the rent 100k; the subjects hold
    // 110k of it, so 1k (the groceries overspend) is still money to assign, and April's 50k is held elsewhere
    expect(model.startedWithOf(model.plan!)).toBe(205_000 + 11_000 + 100_000);
    expect(model.toAllocateOf(model.plan!)).toBe(205_000 + 1_000 - 50_000);
    // a period ahead has spent nothing: the pool minus its own funding, never counted twice
    expect(model.startedWithOf(model.ahead[0].plan)).toBe(205_000);
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
    // held for later: nothing left unspent in March (10k funded, 11k spent; rent paid) — April's 50k is funded ahead
    expect(model.heldBySegment.get('expenses')).toBe(0);
    expect(model.heldBySegment.get('recurring')).toBe(0);
    expect(model.aheadFundedCents).toBe(50_000);
    expect(model.estimate(new Set(['groceries'])).lastCents).toBe(9_000);
    expect(await planOverspentCount(store, SPACE)).toBe(0); // the real today has no plan in this fixture
  });

  it('the pool reads as what the period started with (user 2026-10-08): the balance plus what already left, assigned by hand', async () => {
    const { store, repo } = await bareFixture();
    stores.push(store);
    // a €1,500 balance after €1,000 went out this period on nothing planned
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.poolCents).toBe(150_000);
    expect(model.unplannedOf(model.plan!).map((m) => m.cents)).toEqual([100_000]);
    expect(model.startedWithOf(model.plan!)).toBe(250_000);
    expect(model.toAllocateOf(model.plan!)).toBe(250_000);
    // Home's safe-to-spend reads funded-and-not-yet-spent per segment: nothing is
    expect([...model.heldBySegment.values()].every((cents) => cents === 0)).toBe(true);

    // groceries went out too (the balance dropped by it): a subject funded 100 over 150 spent hands the
    // 50 overspend back as money still to assign — what the period started with does not move
    await repo.upsert('account', SPACE, 'main', { balanceCents: 135_000 });
    await tx(repo, 'g1', '2026-03-06', -15_000, 'groceries');
    await repo.upsert('planSubject', SPACE, 'gro', { planId: march, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 10_000 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.startedWithOf(model.plan!)).toBe(250_000);
    expect(model.toAllocateOf(model.plan!)).toBe(240_000);
    expect(model.viewsOf(model.plan!)[0].status).toBe('overspent');
    // funding it for what it spent brings the number back down
    await repo.upsert('planSubject', SPACE, 'gro', { fundedCents: 15_000 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.toAllocateOf(model.plan!)).toBe(235_000);
    // the sandbox of the same period reads the same way over its own copy
    const sandbox = planId(SPACE, 'sandbox', '2026-03-01');
    await repo.upsert('plan', SPACE, sandbox, { kind: 'sandbox', periodStart: '2026-03-01' });
    await repo.upsert('planSubject', SPACE, 'gro-sb', { planId: sandbox, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 15_000 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.toAllocateOf(model.sandbox!)).toBe(235_000);

    // the periods ahead still take their funding off, and read the plain pool themselves
    await repo.upsert('plan', SPACE, april, { kind: 'actual', periodStart: '2026-04-01' });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(april, 'recurring', 'rent'), { planId: april, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 50_000 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.toAllocateOf(model.plan!)).toBe(185_000);
    expect(model.startedWithOf(model.ahead[0].plan)).toBe(135_000);
    expect(model.toAllocateOf(model.ahead[0].plan)).toBe(135_000 - 50_000);
    expect(model.heldBySegment.get('expenses')).toBe(0);
    expect(model.aheadFundedCents).toBe(50_000);
  });

  it('what the period started with does not move when a paid recurring cost, loan or goal becomes a subject (user 2026-10-09)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    // beside the rent the fixture paid in March: a loan payment and money put towards a goal
    await repo.upsert('account', SPACE, 'loan', { name: 'Car loan', type: 'loan', currency: 'EUR', balanceCents: -500_000, source: 'manual', paymentCents: 25_000, paymentEvery: 'month', paymentDay: 10 });
    // the type is derived at the join: a row linked to the loan account is a debt payment
    await repo.upsert('transaction', SPACE, 'l1', { accountId: 'main', date: '2026-03-10', amountCents: -25_000, currency: 'EUR', merchant: 'bank', linkedAccountId: 'loan', needsReview: 0 });
    await repo.upsert('goal', SPACE, 'trip', { name: 'Trip', targetCents: 100_000, allocatedCents: 0 });
    await repo.upsert('goalContribution', SPACE, 'c1', { goalId: 'trip', amountCents: 10_000, date: '2026-03-12' });
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });

    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    // the plan holds nothing: every payment sits under Unplanned, the sources first, in the plan's order
    expect(model.unplannedOf(model.plan!).map((r) => [r.kind, r.cents])).toEqual([
      ['recurring', 100_000],
      ['debt', 25_000],
      ['category', 11_000],
      ['goal', 10_000],
    ]);
    const started = 205_000 + 100_000 + 25_000 + 11_000 + 10_000;
    expect(model.startedWithOf(model.plan!)).toBe(started);
    expect(model.toAllocateOf(model.plan!)).toBe(started);

    // the rent becomes a subject, born unfunded: its payment moves from Unplanned into its spending
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'recurring', 'rent'), { planId: march, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 0 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.unplannedOf(model.plan!).map((r) => r.kind)).toEqual(['debt', 'category', 'goal']);
    expect(model.viewsOf(model.plan!)[0].realizedCents).toBe(100_000);
    expect(model.startedWithOf(model.plan!)).toBe(started);
    expect(model.toAllocateOf(model.plan!)).toBe(started);

    // the loan and the goal too
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'debts', 'loan'), { planId: march, segment: 'debts', order: 0, name: 'Car loan', sourceId: 'loan', fundedCents: 0 });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'goals', 'trip'), { planId: march, segment: 'goals', order: 0, name: 'Trip', sourceId: 'trip', fundedCents: 0 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.unplannedOf(model.plan!).map((r) => r.kind)).toEqual(['category']);
    expect(model.startedWithOf(model.plan!)).toBe(started);
    // funding the rent for what it paid is the only thing that brings the head down
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'recurring', 'rent'), { fundedCents: 100_000 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.startedWithOf(model.plan!)).toBe(started);
    expect(model.toAllocateOf(model.plan!)).toBe(started - 100_000);
  });

  it('“already spent” reads the same with or without subjects: an archived loan’s payment counts either way (user 2026-10-23, #557)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    // the user's ING Loan 1: archived, yet its payment left the checking account this period
    await repo.upsert('account', SPACE, 'loan1', { name: 'ING Loan 1', type: 'loan', currency: 'EUR', balanceCents: -300_000, source: 'manual', archived: 1, paymentCents: 44_194, paymentEvery: 'month', paymentDay: 10 });
    await repo.upsert('transaction', SPACE, 'p1', { accountId: 'main', date: '2026-03-10', amountCents: -44_194, currency: 'EUR', merchant: 'ING', linkedAccountId: 'loan1', needsReview: 0 });
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    const subjectId = mirroredSubjectId(march, 'debts', 'loan1');
    await repo.upsert('planSubject', SPACE, subjectId, { planId: march, segment: 'debts', order: 0, name: 'ING Loan 1', sourceId: 'loan1', fundedCents: 44_194 });
    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.viewsOf(model.plan!)[0].realizedCents).toBe(44_194);
    const withSubject = model.startedWithOf(model.plan!);
    expect(withSubject).toBe(205_000 + 11_000 + 100_000 + 44_194);

    // funded, then every subject taken back, then gone: the payment moves under Unplanned and the head stays
    await repo.upsert('planSubject', SPACE, subjectId, { fundedCents: 0 });
    await repo.remove('planSubject', SPACE, subjectId);
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.unplannedOf(model.plan!).find((r) => r.kind === 'debt')).toMatchObject({ sourceId: 'loan1', name: 'ING Loan 1', cents: 44_194 });
    expect(model.startedWithOf(model.plan!)).toBe(withSubject);
  });

  it('two subjects on the same categories count the spending once: the one that came first holds it, the later one is blocked (#535)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('budget', SPACE, 'food', { name: 'Food', amountCents: 20_000, every: 'period', anchor: '2026-01-01', catIds: ['groceries'], active: 1 });
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    await repo.upsert('planSubject', SPACE, 'cons', { planId: march, segment: 'expenses', order: 0, name: 'Consumption', catIds: ['consumption'], targetCents: 11_000, fundedCents: 0 });
    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'budgets', 'food'), { planId: march, segment: 'budgets', order: 0, name: 'Food', sourceId: 'food', fundedCents: 0 });
    const model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    const views = new Map(model.viewsOf(model.plan!).map((v) => [v.subject.name, v]));
    expect(views.get('Consumption')).toMatchObject({ realizedCents: 11_000, overlaps: [] });
    expect(views.get('Food')?.realizedCents).toBe(0);
    expect(views.get('Food')?.overlaps).toEqual([{ holder: expect.objectContaining({ subjectId: 'cons', name: 'Consumption' }), catIds: ['groceries'] }]);
    // the groceries count once in what the period started with — no longer twice
    expect(model.startedWithOf(model.plan!)).toBe(205_000 + 11_000 + 100_000);
    expect(availabilityByCat(model).get('groceries')?.subjectName).toBe('Consumption');
  });

  it('an event’s money leaves the expense subjects: under Unplanned until planned, then its subject counts it and spreads the estimate (#504)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('event', SPACE, 'trip', { name: 'Trip', from: '2026-05-10', to: '2026-05-14', budgetCents: 60_000 });
    await repo.upsert('transaction', SPACE, 'deposit', { accountId: 'main', date: '2026-03-12', amountCents: -9_000, currency: 'EUR', merchant: 'Hotel', catId: 'groceries', eventId: 'trip', needsReview: 0 });
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: march, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 0 });
    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.viewsOf(model.plan!)[0].realizedCents).toBe(11_000);
    expect(model.unplannedOf(model.plan!).find((r) => r.kind === 'event')).toMatchObject({ sourceId: 'trip', cents: 9_000 });
    const started = model.startedWithOf(model.plan!);

    await repo.upsert('planSubject', SPACE, mirroredSubjectId(march, 'events', 'trip'), { planId: march, segment: 'events', order: 0, name: 'Trip', sourceId: 'trip', fundedCents: 0 });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    const trip = model.viewsOf(model.plan!).find((v) => v.subject.segment === 'events')!;
    // March, April, May: the €600 estimate a third at a time
    expect(trip).toMatchObject({ realizedCents: 9_000, targetCents: 20_000, dueThisPeriod: false });
    expect(model.unplannedOf(model.plan!).some((r) => r.kind === 'event')).toBe(false);
    expect(model.startedWithOf(model.plan!)).toBe(started);
  });

  it('a one-off funds an Unplanned row for this period only: the head comes down, the row reads funded, and money for a row that spent nothing still shows (#494)', async () => {
    const { store, repo } = await bareFixture();
    stores.push(store);
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    const [coffee] = model.unplannedOf(model.plan!);
    await repo.upsert('plan', SPACE, march, { oneOffs: [{ key: unplannedKey(coffee), fundedCents: 100_000 }, { key: 'recurring:rent', fundedCents: 5_000 }] });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    const rows = model.unplannedOf(model.plan!);
    expect(rows[0]).toMatchObject({ kind: 'category', cents: 100_000, fundedCents: 100_000 });
    // the rent was not paid yet: its row stands on the money given to it
    expect(rows[1]).toMatchObject({ kind: 'recurring', sourceId: 'rent', name: 'Rent', cents: 0, fundedCents: 5_000 });
    expect(model.startedWithOf(model.plan!)).toBe(250_000);
    expect(model.toAllocateOf(model.plan!)).toBe(250_000 - 105_000);
    // a one-off is held under its row's segment: the rent's 5k waits, the coffee's 100k went out
    expect(model.heldBySegment.get('recurring')).toBe(5_000);
    expect(model.heldBySegment.get('expenses')).toBe(0);
  });

  it('a credit card in the pool brings its balance and its spending; paying it off moves money inside the pool (#532)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('account', SPACE, 'card', { name: 'Card', type: 'credit', currency: 'EUR', balanceCents: -20_000, source: 'manual', paymentCents: 5_000 });
    await repo.upsert('transaction', SPACE, 'swipe', { accountId: 'card', date: '2026-03-04', amountCents: -2_000, currency: 'EUR', merchant: 'Shop', catId: 'groceries', needsReview: 0 });
    await repo.upsert('transaction', SPACE, 'bill', { accountId: 'main', date: '2026-03-05', amountCents: -5_000, currency: 'EUR', merchant: 'Card', linkedAccountId: 'card', needsReview: 0 });
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    // outside the pool the card is a debt: the bill is money that left
    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.unplannedOf(model.plan!).find((r) => r.kind === 'debt')).toMatchObject({ sourceId: 'card', cents: 5_000 });
    // ticked into the pool: its balance counts, its spending counts, its bill is a move inside the pool
    await repo.upsert('space', SPACE, SPACE, { planPoolAccountIds: ['main', 'cash', 'card'] });
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.poolCents).toBe(200_000 + 5_000 - 20_000);
    expect(model.unplannedOf(model.plan!).some((r) => r.kind === 'debt')).toBe(false);
    expect(model.unplannedOf(model.plan!).find((r) => r.kind === 'category')?.cents).toBe(13_000);
  });

  it('a new period carries the last plan over by itself — unless it was started over (#557)', async () => {
    const { store, repo } = await fixture();
    stores.push(store);
    await repo.upsert('plan', SPACE, february, { kind: 'actual', periodStart: '2026-02-01' });
    await repo.upsert('planSubject', SPACE, 'gro', { planId: february, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 0 });
    let model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.plan).toBeNull();
    expect(model.continuable).toBe(true);
    // started over this period: the tombstone keeps the start screen
    await repo.upsert('plan', SPACE, march, { kind: 'actual', periodStart: '2026-03-01' });
    await repo.remove('plan', SPACE, march);
    model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(model.plan).toBeNull();
    expect(model.continuable).toBe(false);
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

    expect(segmentsOf({ segments: [{ kind: 'goals' }, { kind: 'expenses' }, { kind: 'budgets', hidden: 1 }] }).map((s) => s.kind)).toEqual(['goals', 'expenses', 'budgets', 'recurring', 'debts', 'events']);
    const model = buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    expect(sortSubjects(model.subjectsOf(model.plan!), model.segmentsOf(model.plan!)).map((s) => s.id)).toEqual(['gro', 'r']);
    const availability = availabilityByCat(model);
    expect(availability.get('groceries')).toMatchObject({ subjectName: 'Groceries', cents: 20_000 - 11_000 });
    expect(availability.has('coffee')).toBe(false);
  });
});
