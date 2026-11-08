// @vitest-environment happy-dom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { renderWithProviders } from '@/test/harness';
import { AddSourceSheet } from './AddSourceSheet';

/** a model with two recurring costs (one with a brand logo) and one goal to pick from, and no subjects yet */
const model = {
  subjectsOf: () => [],
  data: {
    recurrings: [
      { id: 'r1', name: 'Netflix', kind: 'subscription', active: 1, logo: 'brands/netflix.svg' },
      { id: 'r2', name: 'Rent', kind: 'fixed', active: 1 },
    ],
    accounts: [],
    budgets: [],
    goals: [{ id: 'g1', name: 'Car', archived: 0 }],
  },
} as unknown as PlanningModel;
const plan = { id: 'plan-1' } as PlanRow;

describe('AddSourceSheet (user ss 2026-10-07: "4 of 1")', () => {
  it('the pick belongs to the segment it was made in: switching to another segment starts from nothing', () => {
    const ops = { addMirrored: vi.fn(async () => 'id') } as unknown as PlanningOps;
    const { rerender } = renderWithProviders(<AddSourceSheet segment="recurring" model={model} plan={plan} ops={ops} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('plan-add-source-r1'));
    fireEvent.click(screen.getByTestId('plan-add-source-r2'));
    expect(screen.getByTestId('plan-add-source-all').textContent).toContain('2 of 2');
    expect(screen.getByTestId('plan-add-source-save').textContent).toContain('2');

    rerender(<AddSourceSheet segment="goals" model={model} plan={plan} ops={ops} onClose={() => undefined} />);
    expect(screen.getByTestId('plan-add-source-all').textContent).toContain('0 of 1');
    expect((screen.getByTestId('plan-add-source-save') as HTMLButtonElement).disabled).toBe(true);

    // a pick here adds only what this segment offers
    fireEvent.click(screen.getByTestId('plan-add-source-g1'));
    fireEvent.click(screen.getByTestId('plan-add-source-save'));
    expect(ops.addMirrored).toHaveBeenCalledTimes(1);
    expect(ops.addMirrored).toHaveBeenCalledWith('plan-1', 'goals', expect.objectContaining({ id: 'g1' }));
  });

  it('a recurring cost with a brand logo wears it in the list the way the recurring list does; one without keeps the plan’s tile (user 2026-10-09)', () => {
    const ops = { addMirrored: vi.fn(async () => 'id') } as unknown as PlanningOps;
    renderWithProviders(<AddSourceSheet segment="recurring" model={model} plan={plan} ops={ops} onClose={() => undefined} />);
    expect(screen.getByTestId('plan-add-source-logo-r1').querySelector('img')?.getAttribute('src')).toBe('brands/netflix.svg');
    expect(screen.queryByTestId('plan-add-source-logo-r2')).toBeNull();
    expect(screen.getByTestId('plan-add-source-r2').querySelector('img')).toBeNull();
  });

  it('events (#504): the ones still to come and the undated are offered; an event over before this period or archived is not', () => {
    const withEvents = {
      ...model,
      periodOf: () => ({ start: '2026-10-01', end: '2026-10-31' }),
      data: {
        ...model.data,
        events: [
          { id: 'e1', name: 'Trip', from: '2026-12-01', to: '2026-12-05' },
          { id: 'e2', name: 'Last summer', from: '2026-08-01', to: '2026-08-03' },
          { id: 'e3', name: 'Someday' },
          { id: 'e4', name: 'Closed', from: '2026-12-10', archived: 1 },
          { id: 'e5', name: 'Under way', from: '2026-09-28', to: '2026-10-02' },
        ],
      },
    } as unknown as PlanningModel;
    renderWithProviders(<AddSourceSheet segment="events" model={withEvents} plan={plan} ops={{} as PlanningOps} onClose={() => undefined} />);
    expect(['e1', 'e3', 'e5'].every((id) => screen.queryByTestId(`plan-add-source-${id}`))).toBe(true);
    expect(screen.queryByTestId('plan-add-source-e2')).toBeNull();
    expect(screen.queryByTestId('plan-add-source-e4')).toBeNull();
  });

  it('a budget whose categories a subject already counts is blocked, says who holds them, and frees itself from here (#535)', () => {
    const holder = { subjectId: 's1', name: 'Consumption', segment: 'expenses' };
    const withBudgets = {
      ...model,
      reservationsOf: () => new Map([['groceries', holder]]),
      data: {
        ...model.data,
        catalog: { byId: (id: string) => ({ id, name: id === 'groceries' ? 'Groceries' : id }), childrenOf: () => [] },
        budgets: [
          { id: 'b1', name: 'Food', active: 1, catIds: ['groceries'] },
          { id: 'b2', name: 'Fun', active: 1, catIds: ['entertainment'] },
        ],
      },
    } as unknown as PlanningModel;
    const ops = { addMirrored: vi.fn(async () => 'id'), freeCategories: vi.fn(async () => undefined), removeSubject: vi.fn(async () => undefined) } as unknown as PlanningOps;
    renderWithProviders(<AddSourceSheet segment="budgets" model={withBudgets} plan={plan} ops={ops} onClose={() => undefined} />);
    expect(screen.getByTestId('plan-add-source-blocked-s1').textContent).toMatch(/Consumption came first and counts Groceries/);
    // only the free budget can be picked
    expect(screen.getByTestId('plan-add-source-all').textContent).toContain('0 of 1');
    fireEvent.click(screen.getByTestId('plan-add-source-free-s1'));
    expect(ops.freeCategories).toHaveBeenCalledWith('s1', ['groceries']);
    expect(ops.removeSubject).not.toHaveBeenCalled();
  });

  it('Select all ticks every candidate and the button counts them', () => {
    const ops = { addMirrored: vi.fn(async () => 'id') } as unknown as PlanningOps;
    renderWithProviders(<AddSourceSheet segment="recurring" model={model} plan={plan} ops={ops} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('plan-add-source-all'));
    expect(screen.getByTestId('plan-add-source-save').textContent).toContain('2');
    fireEvent.click(screen.getByTestId('plan-add-source-all'));
    expect((screen.getByTestId('plan-add-source-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
