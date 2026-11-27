// @vitest-environment happy-dom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
import { DexieBackend } from '@/db/backend';
import { MunniDB } from '@/db/schema';
import { Repo } from '@/db/repo';
import { HlcClock } from '@/sync/hlc';
import { mirroredSubjectId, planId } from '@/domain/planning';
import type { PlanEditability, PlanningOps } from '@/application/planning';
import { buildPlanning, loadPlanningData } from '@/application/planningModel';
import { SubjectScreen } from './SubjectScreen';

const SPACE = 's1';
vi.mock('@/app/data', () => ({ useData: () => ({ spaceId: SPACE }) }));
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => vi.fn() }));

const fmt = (cents: number) => `€${(cents / 100).toFixed(2)}`;
const OCTOBER = planId(SPACE, 'actual', '2026-10-01');
const SEPTEMBER = planId(SPACE, 'actual', '2026-09-01');

const stores: DexieBackend[] = [];
afterEach(async () => {
  cleanup();
  for (const store of stores.splice(0)) await store.destroy();
});

interface Shown {
  sourceId?: string;
  segment?: 'recurring' | 'goals';
  setAsideBefore?: number;
  pace?: 'catchUp';
  funded?: number;
  editability?: PlanEditability;
}

/** €1,000 a year, due 20 May: October is the fifth of its twelve periods, eight to go; the pool holds €5,000 */
async function show(opts: Shown = {}) {
  const store = new DexieBackend(new MunniDB(`munni_subject_${Math.random().toString(36).slice(2)}`));
  stores.push(store);
  const repo = new Repo(store, new HlcClock('subject'), { trackOutbox: false });
  await repo.upsert('space', SPACE, SPACE, { name: 'P', kind: 'personal', currency: 'EUR', periodType: 'month', periodDay: 1 });
  await repo.upsert('account', SPACE, 'main', { name: 'Main', type: 'checking', currency: 'EUR', balanceCents: 500_000, source: 'manual' });
  await repo.upsert('recurring', SPACE, 'ins', { name: 'Insurance', kind: 'fixed', amountCents: 100_000, every: 'year', dueDay: 20, dueMonth: 5, active: 1 });
  await repo.upsert('recurring', SPACE, 'rent', { name: 'Rent', kind: 'fixed', amountCents: 90_000, every: 'month', dueDay: 1, active: 1 });
  await repo.upsert('goal', SPACE, 'bike', { name: 'Bike', targetCents: 120_000, allocatedCents: 0, targetDate: '2027-05-31' });
  const sourceId = opts.sourceId ?? 'ins';
  const segment = opts.segment ?? 'recurring';
  const subject = (plan: string, fundedCents: number, pace?: 'catchUp') =>
    repo.upsert('planSubject', SPACE, mirroredSubjectId(plan, segment, sourceId), { planId: plan, segment, order: 0, name: 'Insurance', sourceId, fundedCents, ...(pace ? { pace } : {}) });
  if (opts.setAsideBefore) {
    await repo.upsert('plan', SPACE, SEPTEMBER, { kind: 'actual', periodStart: '2026-09-01' });
    await subject(SEPTEMBER, opts.setAsideBefore);
  }
  await repo.upsert('plan', SPACE, OCTOBER, { kind: 'actual', periodStart: '2026-10-01' });
  await subject(OCTOBER, opts.funded ?? 0, opts.pace);
  const model = buildPlanning(await loadPlanningData(store, SPACE), '2026-10-15');
  const ops = { setPace: vi.fn(async () => undefined), fund: vi.fn(async () => undefined), snooze: vi.fn(async () => undefined), cover: vi.fn(async () => undefined) };
  const onClose = vi.fn();
  const view = model.viewsOf(model.plan!)[0];
  render(
    <LangProvider>
      <SubjectScreen view={view} model={model} plan={model.plan!} editability={opts.editability ?? 'full'} ops={ops as unknown as PlanningOps} fmt={fmt} currency="EUR" onClose={onClose} onEdit={() => undefined} />
    </LangProvider>,
  );
  return { ops, onClose, subjectId: view.subject.id };
}

const text = (id: string) => screen.getByTestId(id).textContent;
const input = () => screen.getByTestId('plan-fund-input') as HTMLInputElement;
const disabled = (id: string) => (screen.getByTestId(id) as HTMLButtonElement).disabled;

describe('a plan subject on its own page (#692)', () => {
  it('shows what it holds, its target and what the pool keeps — and nothing about where the money came from', async () => {
    await show({ setAsideBefore: 30_000 });
    expect(text('plan-page-name')).toBe('Insurance');
    // what September set aside is simply what it holds
    expect(input().value).toBe('300.00');
    expect(text('plan-page-target')).toBe('Target €387.50');
    expect(text('plan-page-pool')).toBe('€4700.00');
    expect(text('plan-page-spent')).toBe('Spent€0.00');
    expect(text('plan-page-second')).toBe('Not funded€87.50');
    expect(screen.getByTestId('screen-plan-subject').textContent).not.toMatch(/earlier periods|from before/);
    expect(disabled('plan-fund-save')).toBe(true);
  });

  it('the amount is a draft: the pool, the bar and the figures follow it, and only Save changes writes it', async () => {
    const { ops, onClose, subjectId } = await show({ setAsideBefore: 30_000 });
    fireEvent.click(screen.getByTestId('plan-fund-fill'));
    expect(input().value).toBe('387.50');
    expect(text('plan-page-pool')).toBe('€4612.50');
    expect(text('plan-page-second')).toBe('Not funded€0.00');
    expect(disabled('plan-fund-fill')).toBe(true);

    fireEvent.change(input(), { target: { value: '500' } });
    expect(text('plan-page-pool')).toBe('€4500.00');
    expect(text('plan-page-second')).toBe('Above target€112.50');
    expect(screen.getByTestId('plan-sheet-bar-above')).toBeTruthy();
    expect(disabled('plan-fund-fill')).toBe(false);

    fireEvent.click(screen.getByTestId('plan-fund-empty'));
    expect(input().value).toBe('0.00');
    expect(text('plan-page-pool')).toBe('€5000.00');
    expect(text('plan-page-second')).toBe('Not funded€387.50');
    expect(disabled('plan-fund-empty')).toBe(true);
    expect(ops.fund).not.toHaveBeenCalled();

    fireEvent.change(input(), { target: { value: '350,25' } });
    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(ops.fund).toHaveBeenCalledWith(subjectId, 35_025);
    expect(ops.setPace).not.toHaveBeenCalled();
  });

  it('money that leaves in a later period has a funding plan: closed it says the way, opened it offers both', async () => {
    const { ops, onClose, subjectId } = await show({ setAsideBefore: 30_000 });
    expect(text('plan-pace-due')).toBe('Due 20 May 2027 · €1000.00');
    expect(text('plan-pace-chosen')).toBe('Spread out');
    expect(text('plan-pace-line')).toBe('€87.50 per period · 8 periods left');
    expect(screen.queryByTestId('plan-pace-catchUp')).toBeNull();

    fireEvent.click(screen.getByTestId('plan-pace-toggle'));
    expect(text('plan-pace-facts')).toBe('8 periods remaining, including this one.');
    expect(screen.getByTestId('plan-pace-spread').getAttribute('aria-checked')).toBe('true');
    expect(text('plan-pace-spread-now')).toBe('€87.50');
    expect(text('plan-pace-spread-sub')).toBe('€87.50 this period and every period until due.');
    expect(text('plan-pace-catchUp-now')).toBe('€116.67');
    expect(text('plan-pace-catchUp-sub')).toBe('€116.67 this period, then €83.33 per period, as if you had funded it from the start.');

    // a draft like the amount: the target follows at once, the plan after Save changes
    fireEvent.click(screen.getByTestId('plan-pace-catchUp'));
    expect(screen.getByTestId('plan-pace-catchUp').getAttribute('aria-checked')).toBe('true');
    expect(text('plan-pace-chosen')).toBe('Catch up');
    expect(text('plan-pace-line')).toBe('€116.67 now · €83.33 per period after');
    expect(text('plan-page-target')).toBe('Target €416.67');
    expect(text('plan-page-second')).toBe('Not funded€116.67');
    expect(ops.setPace).not.toHaveBeenCalled();
    expect(disabled('plan-fund-save')).toBe(false);

    fireEvent.click(screen.getByTestId('plan-fund-save'));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(ops.setPace).toHaveBeenCalledWith(subjectId, 'catchUp');
    expect(ops.fund).not.toHaveBeenCalled();
  });

  it('the way the subject already goes is shown; on pace, catching up is one share like every period', async () => {
    await show({ setAsideBefore: 33_334, pace: 'catchUp' });
    expect(text('plan-pace-chosen')).toBe('Catch up');
    // one even share: there is no "now, then"
    expect(text('plan-pace-line')).toBe('€83.33 per period · 8 periods left');
    fireEvent.click(screen.getByTestId('plan-pace-toggle'));
    expect(text('plan-pace-catchUp-sub')).toBe('€83.33 per period: you are on pace.');
    expect(disabled('plan-fund-save')).toBe(true);
  });

  it('a goal with a date has a funding plan too; a cost due every period has none', async () => {
    await show({ sourceId: 'bike', segment: 'goals' });
    expect(text('plan-pace-due')).toBe('Due 31 May 2027 · €1200.00');
    expect(text('plan-pace-line')).toBe('€150.00 per period · 8 periods left');
    cleanup();
    await show({ sourceId: 'rent' });
    expect(screen.queryByTestId('plan-pace')).toBeNull();
    expect(text('plan-page-target')).toBe('Target €900.00');
  });

  it('Cover from… waits until the pool has nothing left; a plan that can only be looked at offers no change', async () => {
    await show();
    expect(disabled('plan-fund-cover')).toBe(true);
    cleanup();
    await show({ editability: 'readOnly' });
    expect(input().readOnly).toBe(true);
    expect(screen.queryByTestId('plan-fund-save')).toBeNull();
    expect(screen.queryByTestId('plan-fund-fill')).toBeNull();
    expect(screen.queryByTestId('plan-fund-remove')).toBeNull();
    expect(screen.getByTestId('plan-sheet-readonly')).toBeTruthy();
    fireEvent.click(screen.getByTestId('plan-pace-toggle'));
    expect(disabled('plan-pace-catchUp')).toBe(true);
  });
});
