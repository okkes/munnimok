import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { coverCandidates, slackCents } from '@/domain/planning';
import type { SubjectView } from '@/domain/planning';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import type { MoneyFmt } from './SegmentSection';
import { StatusBar, statusLine } from './SegmentSection';
import { SourceTile } from './SourceTile';
import { STATUS_TONE } from './planningUi';

/** what a move takes from a subject with room: never more than it spares, never more than the red needs */
const moveFrom = (from: SubjectView, needCents: number): number => Math.min(slackCents(from), needCents);

/** one place the money can come from, and what the move leaves behind there */
function SourceRow({
  view,
  model,
  needCents,
  fmt,
  currency,
  onMove,
}: Readonly<{ view: SubjectView; model: PlanningModel; needCents: number; fmt: MoneyFmt; currency: string; onMove: (cents: number) => void }>) {
  const { t } = useLang();
  const moved = moveFrom(view, needCents);
  const left = view.fundedCents - moved;
  const target = view.targetCents ?? 0;
  // the consequence, in so many words: a subject pushed under its target will want money again
  const short = target > 0 && left < target;
  return (
    <Row
      kind="data"
      testId={`plan-review-from-${view.subject.id}`}
      leading={<SourceTile segment={view.subject.segment} sourceId={view.subject.sourceId} icon={view.subject.icon} color={view.subject.color} model={model} />}
      title={view.subject.name}
      sub={
        <span className={short ? 'text-warning' : undefined}>
          {short ? t('plan.review.leavesShort', { left: fmt(left, currency), target: fmt(target, currency) }) : t('plan.review.leaves', { left: fmt(left, currency) })}
        </span>
      }
      trailing={<span className="m-num text-[13px] font-semibold text-ink">{fmt(moved, currency)}</span>}
      chevron={false}
      onClick={() => onMove(moved)}
    />
  );
}

/**
 * The subjects in the red, one at a time (user 2026-10-23, #557: "like the
 * transaction review … I don't want an auto fix button, it takes away the
 * conscious decision"). Each card says how far the subject went over and
 * where money could come from — what is left to give a job, or a subject
 * with room — with what each move leaves behind there, so every euro moved
 * is a choice. Nothing moves by itself; skipping is always allowed.
 */
export function OverspentReview({
  onClose,
  model,
  plan,
  ops,
  fmt,
  currency,
}: Readonly<{ onClose: () => void; model: PlanningModel; plan: PlanRow; ops: PlanningOps; fmt: MoneyFmt; currency: string }>) {
  const { t } = useLang();
  const views = model.viewsOf(plan);
  // the walk is the red list as it stood when the review opened — fixing one never reshuffles the rest
  const [queue] = useState<string[]>(() => views.filter((v) => v.status === 'overspent').map((v) => v.subject.id));
  const [index, setIndex] = useState(0);
  const current = views.find((v) => v.subject.id === queue[index]) ?? null;
  const done = index >= queue.length;
  const next = () => setIndex((i) => i + 1);
  // a subject the last move made whole hands over to the next one by itself
  const healed = !!current && current.status !== 'overspent';
  const currentId = current?.subject.id;
  useEffect(() => {
    if (healed) setIndex((i) => i + 1);
  }, [healed, currentId]);

  const need = current ? Math.max(0, current.realizedCents - current.fundedCents) : 0;
  const left = model.toAllocateOf(plan);
  const fromPool = Math.min(Math.max(0, left), need);
  const candidates = current ? coverCandidates(views, current.subject.id).all : [];
  const stillRed = queue.filter((id) => views.find((v) => v.subject.id === id)?.status === 'overspent').length;

  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('plan.review.title')}
      size="tall"
      footer={
        done || !current ? (
          <Button className="w-full" data-testid="plan-review-close" onClick={onClose}>
            {t('action.done')}
          </Button>
        ) : (
          <Button variant="outline" className="w-full" data-testid="plan-review-skip" onClick={next}>
            {t('plan.review.skip')}
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3" data-testid="plan-review">
        {done || !current ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center" data-testid="plan-review-done">
            <Icon name={stillRed === 0 ? 'check-circle-outline' : 'alert-circle-outline'} size={32} color={stillRed === 0 ? 'var(--m-accent-deep)' : 'var(--m-warning)'} />
            <p className="text-[14px] text-ink">{stillRed === 0 ? t('plan.review.allHealthy') : t('plan.review.someLeft', { n: stillRed })}</p>
          </div>
        ) : (
          <>
            <div className="m-cap px-1" data-testid="plan-review-progress">
              {t('plan.review.progress', { n: index + 1, total: queue.length })}
            </div>
            <div className="rounded-card border border-line bg-surface p-3" data-testid={`plan-review-subject-${current.subject.id}`}>
              <div className="flex items-center gap-3">
                <SourceTile segment={current.subject.segment} sourceId={current.subject.sourceId} icon={current.subject.icon} color={current.subject.color} model={model} size={48} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[15px] font-medium text-ink">{current.subject.name}</div>
                  <Pill tone={STATUS_TONE[current.status]} testId="plan-review-status">
                    {statusLine(current, t, fmt, currency)}
                  </Pill>
                </div>
              </div>
              <div className="mt-2">
                <StatusBar view={current} />
              </div>
              <div className="mt-1 text-[11px] text-ink-4">
                {t('plan.fundedOf', { funded: fmt(current.fundedCents, currency), target: current.targetCents === null ? '—' : fmt(current.targetCents, currency) })}
                {' · '}
                {t('plan.spentShort', { amount: fmt(current.realizedCents, currency) })}
              </div>
            </div>
            <p className="flex items-start gap-2 text-[12px] text-ink-3" data-testid="plan-review-why">
              <Icon name="information-outline" size={14} />
              <span>{t('plan.review.why', { amount: fmt(need, currency) })}</span>
            </p>
            <div className="m-cap px-1">{t('plan.review.from')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
              {fromPool > 0 && (
                <Row
                  kind="data"
                  testId="plan-review-from-pool"
                  icon="bank-outline"
                  title={t('plan.review.fromPool')}
                  sub={t('plan.review.poolLeaves', { left: fmt(left - fromPool, currency) })}
                  trailing={<span className="m-num text-[13px] font-semibold text-ink">{fmt(fromPool, currency)}</span>}
                  chevron={false}
                  onClick={() => void ops.fund(current.subject.id, current.fundedCents + fromPool)}
                />
              )}
              {candidates.map((view) => (
                <SourceRow
                  key={view.subject.id}
                  view={view}
                  model={model}
                  needCents={need}
                  fmt={fmt}
                  currency={currency}
                  onMove={(cents) => void ops.cover(view.subject.id, current.subject.id, cents)}
                />
              ))}
              {fromPool === 0 && candidates.length === 0 && (
                <p className="px-4 py-3 text-[12px] text-ink-4" data-testid="plan-review-nowhere">
                  {t('plan.review.nowhere')}
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
