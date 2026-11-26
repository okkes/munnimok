import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import type { TFunc, TranslationKey } from '@/i18n';
import type { PlanSegmentKind } from '@/db/types';
import type { PlanningModel } from '@/application/planning';
import type { SubjectView } from '@/domain/planning';
import { shortfallCents, slackCents } from '@/domain/planning';
import { Collapse } from '@/ui/Collapse';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { PlanBar } from './PlanBar';
import { SourceTile } from './SourceTile';
import { SEGMENT_META, STATUS_KEY, STATUS_TONE } from './planningUi';

export type MoneyFmt = (cents: number, currency: string) => string;

/** why a subject of a period ahead needs nothing (#557) */
export const SETTLED_KEY: Partial<Record<PlanSegmentKind, TranslationKey>> = {
  debts: 'plan.settled.debts',
  goals: 'plan.settled.goals',
  events: 'plan.settled.events',
};

export function statusLine(view: SubjectView, t: TFunc, fmt: MoneyFmt, currency: string): string {
  const key = STATUS_KEY[view.status];
  if (view.status === 'underfunded') return t(key, { amount: fmt(shortfallCents(view), currency) });
  if (view.status === 'overspent') return t(key, { amount: fmt(view.realizedCents - view.fundedCents, currency) });
  if (view.status === 'overTarget') return t(key, { amount: fmt(view.realizedCents - (view.targetCents ?? 0), currency) });
  return t(key);
}

/** #691: what is spent and what the funding still holds, in words — once something was spent and the funding covers it */
export function spentLine(view: SubjectView, t: TFunc, fmt: MoneyFmt, currency: string): string {
  const spent = t('plan.spentShort', { amount: fmt(view.realizedCents, currency) });
  const covered = view.realizedCents > 0 && view.fundedCents >= view.realizedCents;
  return covered ? `${spent} · ${t('plan.leftShort', { amount: fmt(slackCents(view), currency) })}` : spent;
}

export function SubjectRow({
  view,
  model,
  fmt,
  currency,
  onClick,
  onFundToTarget,
}: Readonly<{ view: SubjectView; model?: PlanningModel; fmt: MoneyFmt; currency: string; onClick: () => void; onFundToTarget?: () => void }>) {
  const { t } = useLang();
  const { subject } = view;
  const tone = STATUS_TONE[view.status];
  return (
    <button
      data-testid={`plan-subject-${subject.id}`}
      onClick={(e) => {
        // the Needs chip funds in one tap; one button, so no button inside a button;
        // the sheet's Fill to target is the keyboard route
        const chip = (e.target as HTMLElement).closest('[data-testid^="plan-subject-need-"]');
        if (chip && onFundToTarget) onFundToTarget();
        else onClick();
      }}
      data-skipped={subject.snoozed === 1}
      data-settled={view.settledAhead}
      className={`m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0${subject.snoozed === 1 || view.settledAhead ? ' opacity-55' : ''}`}
    >
      <SourceTile segment={subject.segment} sourceId={subject.sourceId} icon={subject.icon} color={subject.color} model={model} testId={`plan-subject-logo-${subject.id}`} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{subject.name}</span>
          {view.status === 'underfunded' && onFundToTarget ? (
            <span data-testid={`plan-subject-need-${subject.id}`} title={t('plan.fund.fill')} className="shrink-0 rounded-full">
              <Pill tone={tone} testId={`plan-subject-status-${subject.id}`}>
                {statusLine(view, t, fmt, currency)}
              </Pill>
            </span>
          ) : (
            <Pill tone={tone} testId={`plan-subject-status-${subject.id}`}>
              {statusLine(view, t, fmt, currency)}
            </Pill>
          )}
        </span>
        <span className="mt-1 block">
          <PlanBar view={view} testId={`plan-subject-bar-${subject.id}`} />
        </span>
        {/* the two halves wrap under each other where the row is too narrow for both */}
        <span className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[11px] text-ink-4">
          <span className="m-num" data-testid={`plan-subject-funded-${subject.id}`}>
            {t('plan.fundedOf', { funded: fmt(view.fundedCents, currency), target: view.targetCents === null ? '—' : fmt(view.targetCents, currency) })}
          </span>
          <span className="m-num" data-testid={`plan-spentline-${subject.id}`}>
            {spentLine(view, t, fmt, currency)}
            {view.carriedCents > 0 && ` · ${t('plan.carried', { amount: fmt(view.carriedCents, currency) })}`}
          </span>
        </span>
        {/* #557: ahead, funding before this period already settles it: stays listed, asks for nothing */}
        {view.settledAhead && (
          <span className="mt-1 block text-[11px] text-ink-4" data-testid={`plan-subject-settled-${subject.id}`}>
            {t(SETTLED_KEY[subject.segment] ?? 'plan.settled.events')}
          </span>
        )}
        {view.orphaned && (
          <span className="mt-1 block text-[11px] text-negative" data-testid={`plan-subject-orphan-${subject.id}`}>
            {t('plan.orphaned')}
          </span>
        )}
        {/* first come keeps its place (#535): a later subject says whose categories it cannot count */}
        {view.overlaps.map((overlap) => (
          <span key={overlap.holder.subjectId} className="mt-1 block text-[11px] text-warning" data-testid={`plan-subject-overlap-${subject.id}`}>
            {t('plan.overlapRow', { name: overlap.holder.name, n: overlap.catIds.length })}
          </span>
        ))}
        {view.inPool && (
          <span className="mt-1 block text-[11px] text-ink-4" data-testid={`plan-subject-inpool-${subject.id}`}>
            {t('plan.debtInPool')}
          </span>
        )}
      </span>
      <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
    </button>
  );
}

export function SegmentSection({
  kind,
  views,
  model,
  editable,
  canFill,
  fmt,
  currency,
  onFill,
  onFundToTarget,
  onAdd,
  onOpen,
  folded = false,
  onToggleFold,
  extra,
}: Readonly<{
  kind: PlanSegmentKind;
  views: SubjectView[];
  /** rows of the segment that are no subjects, under them (#455: what a cashed-out goal bought) */
  extra?: ReactNode;
  model?: PlanningModel;
  editable: boolean;
  /** money can be moved (the previous period allows that much) */
  canFill: boolean;
  fmt: MoneyFmt;
  currency: string;
  onFill: () => void;
  onFundToTarget: (view: SubjectView) => void;
  onAdd: () => void;
  onOpen: (view: SubjectView) => void;
  folded?: boolean;
  onToggleFold?: () => void;
}>) {
  const { t } = useLang();
  const meta = SEGMENT_META[kind];
  const funded = views.reduce((sum, v) => sum + v.fundedCents, 0);
  const spent = views.reduce((sum, v) => sum + v.realizedCents, 0);
  const need = views.reduce((sum, v) => sum + shortfallCents(v), 0);
  const attention = views.filter((v) => v.status === 'overspent' || v.status === 'underfunded').length;
  return (
    <section data-testid={`plan-segment-${kind}`} className="mt-5" data-folded={folded}>
      <div className="m-cap mb-1 flex items-center justify-between gap-2 px-1">
        <button
          type="button"
          data-testid={`plan-segment-fold-${kind}`}
          aria-expanded={!folded}
          onClick={onToggleFold}
          className="m-tap flex min-w-0 items-center gap-1.5 border-none bg-transparent p-0 text-left text-inherit"
        >
          <Icon name="chevron-down" size={14} style={{ transform: folded ? 'rotate(-90deg)' : undefined, transition: 'transform 200ms ease-out' }} />
          <Icon name={meta.icon} size={14} />
          <span className="truncate">{t(meta.labelKey)}</span>
          <span className="m-num font-normal normal-case text-ink-4" data-testid={`plan-segment-total-${kind}`}>
            {fmt(funded, currency)}
          </span>
        </button>
        <span className="flex shrink-0 items-center gap-1">
          {canFill && need > 0 && (
            <button
              data-testid={`plan-segment-fundall-${kind}`}
              onClick={onFill}
              className="m-tap border-none bg-transparent text-[11px] font-semibold normal-case text-accent-deep"
            >
              {t('plan.fundSegment', { amount: fmt(need, currency) })}
            </button>
          )}
          {editable && (
            <button
              data-testid={`plan-segment-add-${kind}`}
              onClick={onAdd}
              aria-label={t(meta.addKey)}
              className="m-tap flex h-7 w-7 items-center justify-center rounded-full border-none bg-accent-soft text-accent-deep"
            >
              <Icon name="plus" size={16} />
            </button>
          )}
        </span>
      </div>
      <Collapse open={folded}>
        <button
          type="button"
          data-testid={`plan-segment-summary-${kind}`}
          onClick={onToggleFold}
          className="m-tap flex w-full flex-wrap items-center gap-x-3 gap-y-0.5 rounded-card border border-line bg-surface px-4 py-2.5 text-left text-[12px] text-ink-3"
        >
          <span>{t('plan.foldSummary', { n: views.length, funded: fmt(funded, currency), spent: fmt(spent, currency) })}</span>
          {attention > 0 && <span className="font-medium text-warning">{t('plan.foldAttention', { n: attention })}</span>}
        </button>
      </Collapse>
      <Collapse open={!folded}>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {views.length === 0 ? (
            !extra && (
              <p className="px-4 py-3 text-[12px] text-ink-4" data-testid={`plan-segment-empty-${kind}`}>
                {t('plan.segmentEmpty')}
              </p>
            )
          ) : (
            views.map((view) => (
              <SubjectRow
                key={view.subject.id}
                view={view}
                model={model}
                fmt={fmt}
                currency={currency}
                onClick={() => onOpen(view)}
                onFundToTarget={canFill ? () => onFundToTarget(view) : undefined}
              />
            ))
          )}
          {extra}
        </div>
      </Collapse>
    </section>
  );
}
