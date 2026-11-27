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
  setAside: null,
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

  // #691: the bar says where the money stands; the widths are shares of the longest of target, funding and spending
  const widths = () =>
    Object.fromEntries(
      (['spent', 'left', 'over'] as const).map((part) => [part, (screen.queryByTestId(`plan-subject-bar-s1-${part}`) as HTMLElement | null)?.style.width ?? null]),
    );

  it('funded and partly spent: the spent part, then what is still there — and the line says how much', () => {
    show(view({ status: 'funded', targetCents: 100_00, fundedCents: 100_00, realizedCents: 35_00 }));
    expect(widths()).toEqual({ spent: '35%', left: '65%', over: null });
    expect(screen.getByTestId('plan-spentline-s1').textContent).toBe('spent €35.00 · €65.00 left');
    expect(screen.getByTestId('plan-subject-bar-s1').getAttribute('aria-label')).toBe('Spent, Still there');
  });

  it('underfunded and partly spent: spent, still there, and the rest of the target stays bare', () => {
    show(view({ targetCents: 100_00, fundedCents: 60_00, realizedCents: 35_00 }));
    expect(widths()).toEqual({ spent: '35%', left: '25%', over: null });
    expect(screen.getByTestId('plan-subject-bar-s1').getAttribute('aria-label')).toBe('Spent, Still there, Not funded');
  });

  it('everything funded is spent: one full spent part, nothing left', () => {
    show(view({ status: 'funded', targetCents: 100_00, fundedCents: 100_00, realizedCents: 100_00 }));
    expect(widths()).toEqual({ spent: '100%', left: null, over: null });
    expect(screen.getByTestId('plan-spentline-s1').textContent).toBe('spent €100.00 · €0.00 left');
  });

  it('overspent: what the funding paid, then the part beyond it — the line leaves "left" out', () => {
    show(view({ status: 'overspent', targetCents: 100_00, fundedCents: 100_00, realizedCents: 125_00 }));
    expect(widths()).toEqual({ spent: '80%', left: null, over: '20%' });
    expect(screen.getByTestId('plan-spentline-s1').textContent).toBe('spent €125.00');
  });

  it('nothing funded, nothing spent: a bare bar; nothing spent yet says nothing about what is left', () => {
    show(view({ targetCents: 100_00 }));
    expect(widths()).toEqual({ spent: null, left: null, over: null });
    expect(screen.getByTestId('plan-subject-bar-s1').getAttribute('aria-label')).toBe('Not funded');
    cleanup();
    show(view({ targetCents: 100_00, fundedCents: 60_00 }));
    expect(widths()).toEqual({ spent: null, left: '60%', over: null });
    expect(screen.getByTestId('plan-spentline-s1').textContent).toBe('spent €0.00');
  });

  it('spent past the target while the funding covers it (#517): stripes on that stretch only', () => {
    show(view({ status: 'overTarget', targetCents: 100_00, fundedCents: 200_00, realizedCents: 150_00 }));
    expect(widths()).toEqual({ spent: '75%', left: '25%', over: null });
    const stripes = screen.getByTestId('plan-subject-bar-s1-stripes');
    expect(stripes.style.left).toBe('50%');
    expect(stripes.style.width).toBe('25%');
  });

  it('a goal and an event say their own reason', () => {
    show(view({ status: 'settled', settledAhead: true }, { segment: 'goals' }));
    expect(screen.getByTestId('plan-subject-settled-s1').textContent).toMatch(/^Reached by/);
    cleanup();
    show(view({ status: 'settled', settledAhead: true }, { segment: 'events' }));
    expect(screen.getByTestId('plan-subject-settled-s1').textContent).toMatch(/^Fully funded before/);
  });
});
