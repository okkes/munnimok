// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
import type { PlanSubjectRow } from '@/db/types';
import type { SubjectView } from '@/domain/planning';
import { SubjectRow } from './SegmentSection';

const fmt = (cents: number) => `€${(cents / 100).toFixed(2)}`;

const view = (over: Partial<SubjectView>, subject: Partial<PlanSubjectRow> = {}): SubjectView => ({
  subject: { id: 's1', spaceId: 'sp', planId: 'p', segment: 'recurring', order: 0, name: 'Insurance', fundedCents: 0, hlc: '', deleted: 0, fieldVersions: {}, ...subject } as PlanSubjectRow,
  targetCents: 100_00,
  fundedCents: 0,
  realizedCents: 0,
  carriedCents: 0,
  settledAhead: false,
  cycles: 1,
  status: 'underfunded',
  orphaned: false,
  dueThisPeriod: false,
  overlaps: [],
  inPool: false,
  ...over,
});

const show = (subjectView: SubjectView) =>
  render(
    <LangProvider>
      <SubjectRow view={subjectView} fmt={fmt} currency="EUR" onClick={() => {}} />
    </LangProvider>,
  );

describe('a subject’s row in the plan (#557)', () => {
  afterEach(cleanup);

  it('what rolled over shows as funding, with a word on where it came from', () => {
    show(view({ fundedCents: 700_00, targetCents: 720_00, carriedCents: 600_00 }));
    expect(screen.getByTestId('plan-subject-funded-s1').textContent).toBe('€700.00 of €720.00');
    expect(screen.getByTestId('plan-subject-s1').textContent).toContain('incl. €600.00 from before');
    expect(screen.queryByTestId('plan-subject-settled-s1')).toBeNull();
  });

  it('ahead, a loan the funding before it pays off stays in the list, greyed, with nothing to fund', () => {
    show(view({ status: 'settled', settledAhead: true, targetCents: 0 }, { segment: 'debts', name: 'Car loan' }));
    const row = screen.getByTestId('plan-subject-s1');
    expect(row.getAttribute('data-settled')).toBe('true');
    expect(row.className).toContain('opacity-55');
    expect(screen.getByTestId('plan-subject-status-s1').textContent).toBe('Nothing to fund');
    expect(screen.getByTestId('plan-subject-settled-s1').textContent).toMatch(/^Paid off by what the periods before/);
  });

  it('a goal and an event say their own reason', () => {
    show(view({ status: 'settled', settledAhead: true }, { segment: 'goals' }));
    expect(screen.getByTestId('plan-subject-settled-s1').textContent).toMatch(/^Reached by/);
    cleanup();
    show(view({ status: 'settled', settledAhead: true }, { segment: 'events' }));
    expect(screen.getByTestId('plan-subject-settled-s1').textContent).toMatch(/^Fully funded before/);
  });
});
