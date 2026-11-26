// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { mirroredSubjectId, planId } from '@/domain/planning';
import type { PlanningOps } from '@/application/planning';
import { buildPlanning, loadPlanningData } from '@/application/planningModel';
import { PaceChooser } from './PaceChooser';

const SPACE = 's1';
const fmt = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const OCTOBER = planId(SPACE, 'actual', '2026-10-01');
const SEPTEMBER = planId(SPACE, 'actual', '2026-09-01');

const stores: DexieBackend[] = [];
afterEach(async () => {
  cleanup();
  for (const store of stores.splice(0)) await store.destroy();
});

/** €1,000 a year, due 20 May: October is the fifth of its twelve periods, eight to go */
async function show(opts: { sourceId?: string; setAsideBefore?: number; planPace?: 'catchUp'; canEdit?: boolean } = {}) {
  const store = new DexieBackend(new MunniDB(`munni_pace_${Math.random().toString(36).slice(2)}`));
  stores.push(store);
  const repo = new Repo(store, new HlcClock('pace'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('recurring', SPACE, 'ins', { name: 'Insurance', kind: 'fixed', amountCents: 100_000, every: 'year', dueDay: 20, dueMonth: 5, active: 1, ...(opts.planPace ? { planPace: opts.planPace } : {}) });
  await repo.upsert('recurring', SPACE, 'rent', { name: 'Rent', kind: 'fixed', amountCents: 90_000, every: 'month', dueDay: 1, active: 1 });
  const sourceId = opts.sourceId ?? 'ins';
  const subject = (plan: string, fundedCents: number) =>
    repo.upsert('planSubject', SPACE, mirroredSubjectId(plan, 'recurring', sourceId), { planId: plan, segment: 'recurring', order: 0, name: 'Insurance', sourceId, fundedCents });
  if (opts.setAsideBefore) {
    await repo.upsert('plan', SPACE, SEPTEMBER, { kind: 'actual', periodStart: '2026-09-01' });
    await subject(SEPTEMBER, opts.setAsideBefore);
  }
  await repo.upsert('plan', SPACE, OCTOBER, { kind: 'actual', periodStart: '2026-10-01' });
  await subject(OCTOBER, 0);
  const model = buildPlanning(await loadPlanningData(store, SPACE), '2026-10-15');
  const setPace = vi.fn(async () => undefined);
  const view = model.viewsOf(model.plan!)[0];
  render(
    <LangProvider>
      <PaceChooser view={view} model={model} plan={model.plan!} ops={{ setPace } as unknown as PlanningOps} fmt={fmt} currency="EUR" canEdit={opts.canEdit ?? true} />
    </LangProvider>,
  );
  return { setPace, subjectId: view.subject.id };
}

const text = (id: string) => screen.getByTestId(id).textContent;

describe('how a cost that is not due every period is set aside (#692)', () => {
  it('nothing set aside yet: spreading asks an eighth, catching up everything five periods would have put by', async () => {
    const { setPace, subjectId } = await show();
    expect(text('plan-pace-facts')).toBe('€1000.00 is due on 20 May 2027 — 8 periods to go, this one included.');
    expect(screen.getByTestId('plan-pace-spread').getAttribute('aria-checked')).toBe('true');
    expect(text('plan-pace-spread-now')).toBe('€125.00');
    expect(text('plan-pace-spread-sub')).toBe('€125.00 this period and every period until it is due.');
    expect(text('plan-pace-catchUp-now')).toBe('€416.67');
    expect(text('plan-pace-catchUp-sub')).toBe('€416.67 this period, then €83.33 a period — as if you had set it aside from the start (this is period 5 of 12).');

    fireEvent.click(screen.getByTestId('plan-pace-catchUp'));
    expect(setPace).toHaveBeenCalledWith(subjectId, 'catchUp');
    // the way it already goes is not written again
    fireEvent.click(screen.getByTestId('plan-pace-spread'));
    expect(setPace).toHaveBeenCalledTimes(1);
  });

  it('some of it is set aside already: both ways count it, and say so', async () => {
    await show({ setAsideBefore: 30_000, planPace: 'catchUp' });
    expect(text('plan-pace-facts')).toContain('€300.00 is set aside already.');
    expect(text('plan-pace-spread-now')).toBe('€87.50');
    expect(text('plan-pace-catchUp-now')).toBe('€116.67');
    expect(screen.getByTestId('plan-pace-catchUp').getAttribute('aria-checked')).toBe('true');
  });

  it('where the even schedule stands already, catching up is one share like every period', async () => {
    await show({ setAsideBefore: 33_333 });
    expect(text('plan-pace-catchUp-now')).toBe('€83.34');
    cleanup();
    await show({ setAsideBefore: 33_334 });
    expect(text('plan-pace-catchUp-sub')).toBe('€83.33 a period: you are where setting it aside from the start would have you (period 5 of 12).');
  });

  it('a plan that can only be looked at shows the way without offering the other; a cost due every period has no choice', async () => {
    await show({ canEdit: false });
    expect((screen.getByTestId('plan-pace-catchUp') as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    await show({ sourceId: 'rent' });
    expect(screen.queryByTestId('plan-pace')).toBeNull();
  });
});
