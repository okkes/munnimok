// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import type { EntityName } from '@/db/types';
import { HlcClock, encodeHlc } from '@/sync/hlc';
import { byBirth, mirroredSubjectId, planId } from '@/domain/planning';
import { buildOps } from './planning';
import { carriedStamp, carriedWrites, orderStamp } from './planningCarry';
import { buildPlanning, loadPlanningData } from './planningModel';

const SPACE = 's1';
const IN_MARCH = '2026-03-15';
const MARCH = { start: '2026-03-01', end: '2026-03-31' };
const feb = planId(SPACE, 'actual', '2026-02-01');
const march = planId(SPACE, 'actual', '2026-03-01');
const gro = `psub:${march}:expenses:gro`;
const fun = `psub:${march}:expenses:fun`;
const rent = mirroredSubjectId(march, 'recurring', 'rent');

const NOON = Date.UTC(2026, 2, 1, 12);
const HOUR = 3_600_000;

interface Device {
  wall: { now: number };
  store: DexieBackend;
  repo: Repo;
  ops: ReturnType<typeof buildOps>;
  shipped: Set<string>;
}

function device(name: string, today = IN_MARCH): Device {
  const wall = { now: NOON - 20 * 24 * HOUR };
  const store = new DexieBackend(new MunniDB(`munni_carry_${name}_${Math.random().toString(36).slice(2)}`));
  const repo = new Repo(store, new HlcClock(name, undefined, () => wall.now), { trackOutbox: true });
  return { wall, store, repo, ops: buildOps(store, repo, SPACE, today), shipped: new Set() };
}

/** a sync round's effect: what `from` wrote and has not sent yet merges on `to` */
async function ship(from: Device, to: Device): Promise<void> {
  const ops = (await from.store.outboxAll()).filter((op) => !from.shipped.has(op.opId));
  for (const op of ops) from.shipped.add(op.opId);
  await to.repo.applyRemoteOps(ops);
}

const modelOf = async (d: Device, today = IN_MARCH) => buildPlanning(await loadPlanningData(d.store, SPACE), today);

/** two devices that both hold February's plan: Groceries, Fun and the rent */
async function twoDevices(): Promise<{ a: Device; b: Device }> {
  const a = device('devA');
  const b = device('devB');
  await a.repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await a.repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 200_000, source: 'manual' });
  await a.repo.upsert('recurring', SPACE, 'rent', { name: 'Rent', kind: 'fixed', amountCents: 100_000, catId: 'housingRent', every: 'month', dueDay: 1, active: 1 });
  await a.repo.upsert('plan', SPACE, feb, { kind: 'actual', periodStart: '2026-02-01' });
  await a.repo.upsert('planSubject', SPACE, 'gro', { planId: feb, segment: 'expenses', order: 0, name: 'Groceries', catIds: ['groceries'], targetCents: 15_000, fundedCents: 9_000, snoozed: 0 });
  await a.repo.upsert('planSubject', SPACE, 'fun', { planId: feb, segment: 'expenses', order: 1, name: 'Fun', catIds: ['entertainment'], targetCents: 5_000, fundedCents: 5_000, snoozed: 0 });
  await a.repo.upsert('planSubject', SPACE, mirroredSubjectId(feb, 'recurring', 'rent'), { planId: feb, segment: 'recurring', order: 0, name: 'Rent', sourceId: 'rent', fundedCents: 100_000, snoozed: 0 });
  await ship(a, b);
  return { a, b };
}

/** what a device holds of a row, stamps included — two devices that converged hold the same */
const rowOf = <E extends EntityName>(d: Device, entity: E, id: string) => d.store.get(entity, id);

describe('the carry-over between devices (#557)', () => {
  const devices: Device[] = [];
  afterEach(async () => {
    for (const d of devices.splice(0)) await d.store.destroy();
  });

  it('funding, a changed target and a one-off made after the carry-over survive a device that carries the plan over later', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    a.wall.now = NOON;
    expect(await a.ops.continuePlan()).toBe(true);
    a.wall.now = NOON + HOUR;
    await a.ops.fund(gro, 15_000);
    await a.ops.updateSubject(gro, { targetCents: 20_000 });
    await a.ops.fundOneOff((await modelOf(a)).plan!, 'category:housing', 4_000);

    // the second device has not pulled any of it when it opens Planning, hours later
    b.wall.now = NOON + 6 * HOUR;
    expect((await modelOf(b)).continuable).toBe(true);
    await b.ops.continuePlan();
    await ship(b, a);
    await ship(a, b);

    for (const d of [a, b]) {
      expect(await rowOf(d, 'planSubject', gro)).toMatchObject({ fundedCents: 15_000, targetCents: 20_000, deleted: 0 });
      expect((await rowOf(d, 'plan', march))?.oneOffs).toEqual([{ key: 'category:housing', fundedCents: 4_000 }]);
    }
  });

  it('a subject removed after the carry-over stays removed, and a plan started over stays started over', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    a.wall.now = NOON;
    await a.ops.continuePlan();
    a.wall.now = NOON + HOUR;
    await a.ops.removeSubject(fun);
    b.wall.now = NOON + 6 * HOUR;
    await b.ops.continuePlan();
    await ship(b, a);
    await ship(a, b);
    for (const d of [a, b]) {
      expect((await rowOf(d, 'planSubject', fun))?.deleted).toBe(1);
      expect((await modelOf(d)).subjectsOf((await modelOf(d)).plan!).map((s) => s.name).sort((x, y) => x.localeCompare(y))).toEqual(['Groceries', 'Rent']);
    }

    // Start over on the first device; a third look from a device that knows nothing of March
    const c = device('devC');
    devices.push(c);
    await c.repo.applyRemoteOps((await a.store.outboxAll()).filter((op) => !op.entityId.includes(march)));
    a.wall.now = NOON + 7 * HOUR;
    await a.ops.clearPlan((await modelOf(a)).plan!);
    c.wall.now = NOON + 9 * HOUR;
    await c.ops.continuePlan();
    await ship(c, a);
    const model = await modelOf(a);
    expect(model.plan).toBeNull();
    expect(model.continuable).toBe(false);
  });

  it('two devices that carry from different copies of last period’s plan end on the same rows: each field from the copy that knew it last', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    // late February on the first device only: a higher target and a new name the second never pulled
    a.wall.now = NOON - 2 * 24 * HOUR;
    await a.repo.upsert('planSubject', SPACE, 'gro', { targetCents: 20_000 });
    await a.repo.upsert('planSubject', SPACE, 'fun', { name: 'Fun and games' });

    a.wall.now = NOON;
    await a.ops.continuePlan();
    b.wall.now = NOON + 6 * HOUR;
    await b.ops.continuePlan();
    expect(await rowOf(b, 'planSubject', gro)).toMatchObject({ targetCents: 15_000 });
    await ship(b, a);
    await ship(a, b);

    for (const d of [a, b]) {
      expect(await rowOf(d, 'planSubject', gro)).toMatchObject({ targetCents: 20_000, name: 'Groceries', fundedCents: 0, deleted: 0 });
      expect(await rowOf(d, 'planSubject', fun)).toMatchObject({ name: 'Fun and games', targetCents: 5_000 });
    }
    for (const [entity, id] of [['planSubject', gro], ['planSubject', fun], ['planSubject', rent], ['plan', march]] as const) {
      expect(await rowOf(a, entity, id)).toEqual(await rowOf(b, entity, id));
    }
    // February's first-come order came along
    const model = await modelOf(b);
    expect(byBirth(model.subjectsOf(model.plan!)).map((s) => s.id)).toEqual([gro, fun, rent]);
  });

  it('a carry-over cut short is finished by the next run', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    a.wall.now = NOON;
    const put = a.store.put.bind(a.store);
    let subjectPuts = 0;
    a.store.put = (async (entity: EntityName, row: never) => {
      if (entity === 'planSubject' && (subjectPuts += 1) === 2) throw new Error('cut short');
      return put(entity, row);
    }) as typeof a.store.put;
    await expect(a.ops.continuePlan()).rejects.toThrow();
    a.store.put = put;

    expect(await a.ops.continuePlan()).toBe(true);
    const model = await modelOf(a);
    expect(model.subjectsOf(model.plan!).map((s) => s.name).sort((x, y) => x.localeCompare(y))).toEqual(['Fun', 'Groceries', 'Rent']);
  });

  it('“Like last period” on a device that has not pulled the period’s plan is that same carry-over', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    a.wall.now = NOON;
    await a.ops.continuePlan();
    a.wall.now = NOON + HOUR;
    await a.ops.fund(rent, 100_000);
    await a.ops.fund(gro, 15_000);

    b.wall.now = NOON + 6 * HOUR;
    await b.ops.startPlan(MARCH, { kind: 'last' });
    await ship(b, a);
    await ship(a, b);
    for (const d of [a, b]) {
      const model = await modelOf(d);
      expect(model.subjectsOf(model.plan!).map((s) => [s.id, s.fundedCents]).sort((x, y) => String(x[0]).localeCompare(String(y[0])))).toEqual(
        [[gro, 15_000], [fun, 0], [rent, 100_000]].sort((x, y) => String(x[0]).localeCompare(String(y[0]))),
      );
    }
  });

  it('an empty start on a device that has not pulled the period’s plan leaves that plan as it is', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    a.wall.now = NOON;
    await a.ops.continuePlan();
    a.wall.now = NOON + HOUR;
    await a.ops.fund(rent, 100_000);
    await a.ops.fundOneOff((await modelOf(a)).plan!, 'category:housing', 4_000);
    await a.ops.setSegments((await modelOf(a)).plan!, [{ kind: 'goals' }]);

    b.wall.now = NOON + 6 * HOUR;
    await b.ops.startPlan(MARCH, { kind: 'empty' });
    await ship(b, a);
    await ship(a, b);
    for (const d of [a, b]) {
      expect(await rowOf(d, 'plan', march)).toMatchObject({ oneOffs: [{ key: 'category:housing', fundedCents: 4_000 }], segments: [{ kind: 'goals' }], deleted: 0 });
      expect(await rowOf(d, 'planSubject', rent)).toMatchObject({ fundedCents: 100_000, deleted: 0 });
    }
  });

  it('a period funded ahead and a late carry-over into it are the same rows — what was funded ahead stands', async () => {
    const { a, b } = await twoDevices();
    devices.push(a, b);
    // still February on the first device: March is funded ahead from what is left
    const inFebruary = buildOps(a.store, a.repo, SPACE, '2026-02-15');
    a.wall.now = NOON - 14 * 24 * HOUR;
    await inFebruary.fundAhead(MARCH);
    const ahead = await rowOf(a, 'planSubject', gro);
    expect(ahead).toMatchObject({ name: 'Groceries', fundedCents: 15_000 });

    b.wall.now = NOON + 6 * HOUR;
    await b.ops.continuePlan();
    await ship(b, a);
    await ship(a, b);
    for (const d of [a, b]) {
      const model = await modelOf(d);
      expect(model.subjectsOf(model.plan!).filter((s) => s.name === 'Groceries').map((s) => [s.id, s.fundedCents])).toEqual([[gro, 15_000]]);
    }
  });
});

describe('carried stamps', () => {
  const real = (wallMs: number, counter = 0, deviceId = 'dev') => encodeHlc({ wallMs, counter, deviceId });

  it('sort below every real stamp, follow the order of what they were carried from, and are equal only for equal content', () => {
    const early = carriedStamp(real(1_000), { name: 'Rent' });
    const late = carriedStamp(real(2_000), { name: 'Rent' });
    expect(early < late).toBe(true);
    expect(late < real(1)).toBe(true);
    expect(carriedStamp(real(1_000, 0, 'other'), { name: 'Rent' })).toBe(early);
    expect(carriedStamp(real(1_000), { name: 'Rent ' })).not.toBe(early);
    // field order is no content
    expect(carriedStamp(real(1_000), { a: 1, b: [{ x: 1, y: 2 }] })).toBe(carriedStamp(real(1_000), { b: [{ y: 2, x: 1 }], a: 1 }));
    // the server takes stamps of at most 64 characters
    expect(late.length).toBeLessThanOrEqual(64);
  });

  it('a stamp carried again hands on the moment its content was really written: the order holds period after period', () => {
    const first = carriedStamp(real(1_000), { planId: 'march' });
    const second = carriedStamp(real(2_000), { planId: 'march' });
    const firstAgain = carriedStamp(first, { planId: 'april' });
    const secondAgain = carriedStamp(second, { planId: 'april' });
    expect(firstAgain < secondAgain).toBe(true);
    expect(firstAgain).toHaveLength(first.length);
    // an edit made in between is newer than anything carried
    expect(secondAgain < carriedStamp(real(3_000), { planId: 'april' })).toBe(true);
  });

  it('a row is written field group by field group, each under the stamp of the source fields it comes from', () => {
    // the funding was touched last of all, but the copy sets its own: that rides with the row's first write
    const versions = { planId: real(1_000), name: real(1_000), targetCents: real(5_000), fundedCents: real(9_000) };
    const writes = carriedWrites('planSubject', 'row', { planId: 'march', name: 'Rent', targetCents: 20_000, fundedCents: 0, icon: null }, versions, 'planId', ['fundedCents']);
    expect(writes.map((w) => w.fields)).toEqual([{ planId: 'march', name: 'Rent', fundedCents: 0, icon: null }, { targetCents: 20_000 }]);
    expect(writes[0].hlc < writes[1].hlc).toBe(true);
    expect(writes.every((w) => w.entity === 'planSubject' && w.entityId === 'row')).toBe(true);
  });

  it('a suggestion has no source rows: its place in the list orders it, below anything that was ever written', () => {
    const first = carriedStamp(orderStamp(0), { name: 'Rent' });
    const second = carriedStamp(orderStamp(1), { name: 'Food' });
    expect(first < second).toBe(true);
    expect(second < carriedStamp(real(1_000), { name: 'Rent' })).toBe(true);
  });
});
