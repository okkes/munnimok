import { useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import type { PlanSegmentKind } from '@/db/types';
import type { SubjectView } from '@/domain/planning';
import { shortfallCents } from '@/domain/planning';
import { Icon } from '@/ui/Icon';
import { Pill, ProgressBar, Tile } from '@/ui/primitives';
import { SEGMENT_COLOR, SEGMENT_META, STATUS_KEY, STATUS_TONE, softOf } from './planningUi';

export type MoneyFmt = (cents: number, currency: string) => string;

/** the status chip's text: the shortfall or the overspend when the status carries an amount */
export function statusLine(view: SubjectView, t: TFunc, fmt: MoneyFmt, currency: string): string {
  const key = STATUS_KEY[view.status];
  if (view.status === 'underfunded') return t(key, { amount: fmt(shortfallCents(view), currency) });
  if (view.status === 'overspent') return t(key, { amount: fmt(view.realizedCents - view.fundedCents, currency) });
  return t(key);
}

/** one subject: its face, what it holds against what it needs, how far it is spent */
export function SubjectRow({ view, fmt, currency, onClick }: Readonly<{ view: SubjectView; fmt: MoneyFmt; currency: string; onClick: () => void }>) {
  const { t } = useLang();
  const { subject } = view;
  const color = subject.color ?? SEGMENT_COLOR[subject.segment];
  const tone = STATUS_TONE[view.status];
  const target = view.targetCents ?? 0;
  const barMax = Math.max(target, view.fundedCents, view.realizedCents, 1);
  const funded = view.fundedCents / barMax;
  const spent = view.realizedCents / barMax;
  const barColor = view.status === 'overspent' ? 'var(--m-negative)' : color;
  return (
    <button
      data-testid={`plan-subject-${subject.id}`}
      onClick={onClick}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
    >
      <Tile icon={subject.icon ?? SEGMENT_META[subject.segment].icon} bg={softOf(color)} color={color} />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{subject.name}</span>
          <Pill tone={tone} testId={`plan-subject-status-${subject.id}`}>
            {statusLine(view, t, fmt, currency)}
          </Pill>
        </span>
        <span className="mt-1 block">
          <ProgressBar
            value={funded}
            color={barColor}
            size="sm"
            overlay={
              spent > 0 ? (
                <span aria-hidden className="absolute inset-y-0 left-0 rounded-full opacity-45" style={{ width: `${Math.min(100, spent * 100)}%`, background: 'var(--m-ink-3)' }} />
              ) : null
            }
          />
        </span>
        <span className="mt-1 flex items-baseline justify-between text-[11px] text-ink-4">
          <span className="m-num" data-testid={`plan-subject-funded-${subject.id}`}>
            {t('plan.fundedOf', { funded: fmt(view.fundedCents, currency), target: view.targetCents === null ? '—' : fmt(view.targetCents, currency) })}
          </span>
          <span className="m-num">
            {t('plan.spentShort', { amount: fmt(view.realizedCents, currency) })}
            {view.carriedCents > 0 && ` · ${t('plan.carried', { amount: fmt(view.carriedCents, currency) })}`}
          </span>
        </span>
        {view.orphaned && (
          <span className="mt-1 block text-[11px] text-negative" data-testid={`plan-subject-orphan-${subject.id}`}>
            {t('plan.orphaned')}
          </span>
        )}
      </span>
      <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
    </button>
  );
}

/** a segment: its caption with the subtotal, the fill and add doors, the subjects */
export function SegmentSection({
  kind,
  views,
  editable,
  canFill,
  fmt,
  currency,
  onFill,
  onAdd,
  onOpen,
}: Readonly<{
  kind: PlanSegmentKind;
  views: SubjectView[];
  /** adding and editing subjects is allowed */
  editable: boolean;
  /** money can be moved (the previous period allows that much) */
  canFill: boolean;
  fmt: MoneyFmt;
  currency: string;
  onFill: () => void;
  onAdd: () => void;
  onOpen: (view: SubjectView) => void;
}>) {
  const { t } = useLang();
  const meta = SEGMENT_META[kind];
  const funded = views.reduce((sum, v) => sum + v.fundedCents, 0);
  const need = views.reduce((sum, v) => sum + shortfallCents(v), 0);
  return (
    <section data-testid={`plan-segment-${kind}`} className="mt-5">
      <div className="m-cap mb-1 flex items-center justify-between gap-2 px-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon name={meta.icon} size={14} />
          <span className="truncate">{t(meta.labelKey)}</span>
          <span className="m-num font-normal normal-case text-ink-4" data-testid={`plan-segment-total-${kind}`}>
            {fmt(funded, currency)}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {canFill && need > 0 && (
            <button
              data-testid={`plan-segment-fill-${kind}`}
              onClick={onFill}
              className="m-tap border-none bg-transparent text-[11px] font-semibold normal-case text-accent-deep"
            >
              {t('plan.fillSegment', { amount: fmt(need, currency) })}
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
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {views.length === 0 ? (
          <p className="px-4 py-3 text-[12px] text-ink-4" data-testid={`plan-segment-empty-${kind}`}>
            {t('plan.segmentEmpty')}
          </p>
        ) : (
          views.map((view) => <SubjectRow key={view.subject.id} view={view} fmt={fmt} currency={currency} onClick={() => onOpen(view)} />)
        )}
      </div>
    </section>
  );
}
