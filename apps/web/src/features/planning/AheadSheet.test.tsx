// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOps } from '@/application/planning';
import { buildPlanning, loadPlanningData } from '@/application/planningModel';
import { DexieBackend } from '@/db/backend';
import { Repo } from '@/db/repo';
import { MunniDB } from '@/db/schema';
import { planId } from '@/domain/planning';
import { HlcClock } from '@/sync/hlc';
import { aheadDiffers } from './AheadSheet';

const SPACE = 's1';
const TODAY = '2026-03-15';
const MARCH = { start: '2026-03-01', end: '2026-03-31' };
const march = planId(SPACE, 'actual', MARCH.start);

describe('the periods ahead against this plan (#128)', () => {
  const stores: DexieBackend[] = [];
  afterEach(async () => {
    for (const s of stores.splice(0)) await s.destroy();
  });

  it('a subject that is over by a period ahead is no difference; a subject the period ahead lacks is', async () => {
    const store = new DexieBackend(new MunniDB(`munni_ahead_${Math.random().toString(36).slice(2)}`));
    stores.push(store);
    const repo = new Repo(store, new HlcClock('ahead'), { trackOutbox: false });
    const ops = buildOps(store, repo, SPACE, TODAY);
    const model = async () => buildPlanning(await loadPlanningData(store, SPACE), TODAY);
    await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
    await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 200_000, source: 'manual' });
    await repo.upsert('event', SPACE, 'party', { name: 'Party', from: '2026-03-20', to: '2026-03-21', budgetCents: 5_000 });
    await ops.startPlan(MARCH, { kind: 'empty' });
    await ops.addExpense(march, { name: 'Groceries', catIds: ['groceries'], targetCents: 15_000 });
    await ops.addMirrored(march, 'events', { id: 'party', name: 'Party' });
    await ops.fundAhead((await model()).nextAheadPeriod);

    // April took what still matters then: the party of 20 March stayed behind, and that is as it should be
    let now = await model();
    expect(now.subjectsOf(now.ahead[0].plan).map((s) => s.name)).toEqual(['Groceries']);
    expect(aheadDiffers(now, now.plan!)).toBe(false);

    await ops.addExpense(march, { name: 'Fun', catIds: ['entertainment'], targetCents: 5_000 });
    now = await model();
    expect(aheadDiffers(now, now.plan!)).toBe(true);
    await ops.applyToAhead(now.plan!);
    now = await model();
    expect(aheadDiffers(now, now.plan!)).toBe(false);
  });
});
