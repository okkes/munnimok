// @vitest-environment happy-dom
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { renderWithProviders } from '@/test/harness';
import { AddSourceSheet } from './AddSourceSheet';

/** a model with two recurring costs and one goal to pick from, and no subjects yet */
const model = {
  subjectsOf: () => [],
  data: {
    recurrings: [
      { id: 'r1', name: 'Netflix', active: 1 },
      { id: 'r2', name: 'Rent', active: 1 },
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

  it('Select all ticks every candidate and the button counts them', () => {
    const ops = { addMirrored: vi.fn(async () => 'id') } as unknown as PlanningOps;
    renderWithProviders(<AddSourceSheet segment="recurring" model={model} plan={plan} ops={ops} onClose={() => undefined} />);
    fireEvent.click(screen.getByTestId('plan-add-source-all'));
    expect(screen.getByTestId('plan-add-source-save').textContent).toContain('2');
    fireEvent.click(screen.getByTestId('plan-add-source-all'));
    expect((screen.getByTestId('plan-add-source-save') as HTMLButtonElement).disabled).toBe(true);
  });
});
