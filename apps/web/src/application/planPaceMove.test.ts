// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { mirroredSubjectId, planId } from '@/domain/planning';
import { movePlanPaces } from './planPaceMove';

const SPACE = 's1';
const OCTOBER = planId(SPACE, 'actual', '2026-10-01');
const NOVEMBER = planId(SPACE, 'actual', '2026-11-01');

const stores: DexieBackend[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) await store.destroy();
});

async function device(name: string) {
  const store = new DexieBackend(new MunniDB(`munni_pacemove_${Math.random().toString(36).slice(2)}`));
  stores.push(store);
  return { store, repo: new Repo(store, new HlcClock(name), { trackOutbox: false }) };
}

const cost = async (store: DexieBackend, id: string) => (await store.get('recurring', id)) as unknown as { planPace?: string | null; fieldVersions: Record<string, string> };
const subjectOf = (plan: string, id: string) => mirroredSubjectId(plan, 'recurring', id);

describe('#692: "catch up" kept on a recurring cost moves to the plan subjects of that cost', () => {
  it('every plan subject of the cost takes the choice, the cost lets go of it, and a second pass changes nothing', async () => {
    const { store, repo } = await device('a');
    // 5.32.0 wrote the choice on the cost
    await repo.upsert('recurring', SPACE, 'ins', { name: 'Insurance', kind: 'fixed', amountCents: 100_000, every: 'year', dueDay: 20, dueMonth: 5, active: 1, planPace: 'catchUp' } as never);
    await repo.upsert('recurring', SPACE, 'gym', { name: 'Gym', kind: 'subscription', amountCents: 30_000, every: 'year', dueDay: 1, dueMonth: 3, active: 1 });
    for (const plan of [OCTOBER, NOVEMBER]) {
      await repo.upsert('planSubject', SPACE, subjectOf(plan, 'ins'), { planId: plan, segment: 'recurring', order: 0, name: 'Insurance', sourceId: 'ins', fundedCents: 0 });
      await repo.upsert('planSubject', SPACE, subjectOf(plan, 'gym'), { planId: plan, segment: 'recurring', order: 1, name: 'Gym', sourceId: 'gym', fundedCents: 0 });
    }
    const stamp = (await cost(store, 'ins')).fieldVersions.planPace;

    expect(await movePlanPaces(store, repo)).toBeGreaterThan(0);
    expect((await store.get('planSubject', subjectOf(OCTOBER, 'ins')))?.pace).toBe('catchUp');
    expect((await store.get('planSubject', subjectOf(NOVEMBER, 'ins')))?.pace).toBe('catchUp');
    expect((await store.get('planSubject', subjectOf(OCTOBER, 'gym')))?.pace).toBeUndefined();
    expect((await cost(store, 'ins')).planPace).toBeNull();
    // right behind the value it replaces: the same change on every device
    expect((await cost(store, 'ins')).fieldVersions.planPace).toBe(`${stamp}~`);
    expect((await store.get('planSubject', subjectOf(OCTOBER, 'ins')))?.fieldVersions.pace).toBe(`${stamp}~`);

    expect(await movePlanPaces(store, repo)).toBe(0);
  });

  it('a choice made on the subject since then stays; a cost set back to spreading has nothing to move', async () => {
    const { store, repo } = await device('b');
    await repo.upsert('recurring', SPACE, 'ins', { name: 'Insurance', kind: 'fixed', amountCents: 100_000, every: 'year', dueDay: 20, dueMonth: 5, active: 1, planPace: 'catchUp' } as never);
    // the person chose "spread out" on the new page before this device ran the move
    await repo.upsert('planSubject', SPACE, subjectOf(OCTOBER, 'ins'), { planId: OCTOBER, segment: 'recurring', order: 0, name: 'Insurance', sourceId: 'ins', fundedCents: 0, pace: null as never });
    await movePlanPaces(store, repo);
    expect((await store.get('planSubject', subjectOf(OCTOBER, 'ins')))?.pace ?? null).toBeNull();

    await repo.upsert('recurring', SPACE, 'tax', { name: 'Tax', kind: 'fixed', amountCents: 50_000, every: 'year', dueDay: 1, dueMonth: 2, active: 1, planPace: null } as never);
    const before = (await cost(store, 'tax')).fieldVersions.planPace;
    await movePlanPaces(store, repo);
    expect((await cost(store, 'tax')).fieldVersions.planPace).toBe(before);
  });
});
