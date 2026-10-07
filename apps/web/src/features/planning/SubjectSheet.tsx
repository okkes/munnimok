import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import type { PlanRow, PlanSubjectRow } from '@/db/types';
import type { PlanEditability, PlanningModel, PlanningOps } from '@/application/planning';
import type { SubjectView } from '@/domain/planning';
import { coverCandidates, shortfallCents, slackCents, subjectFamily } from '@/domain/planning';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Pill, Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { SEGMENT_COLOR, SEGMENT_META, STATUS_TONE, softOf } from './planningUi';
import { statusLine } from './SegmentSection';
import { AmountSuggestions } from './AmountSuggestions';
import type { AmountSuggestion } from './AmountSuggestions';
import type { MoneyFmt } from './SegmentSection';

/** the source rows' detail screens, per mirrored segment */
function useOpenSource() {
  const navigate = useNavigate();
  return (subject: PlanSubjectRow) => {
    const id = subject.sourceId;
    if (!id) return;
    switch (subject.segment) {
      case 'recurring':
        void navigate({ to: '/recurring/$recId', params: { recId: id } });
        break;
      case 'debts':
        void navigate({ to: '/debts/$debtId', params: { debtId: id } });
        break;
      case 'budgets':
        void navigate({ to: '/budgets/$budgetId', params: { budgetId: id } });
        break;
      case 'goals':
        void navigate({ to: '/goals/$goalId', params: { goalId: id } });
        break;
      default:
        break;
    }
  };
}

const canSnooze = (view: SubjectView): boolean => view.subject.segment !== 'expenses' && view.subject.segment !== 'budgets';

/** the amount chips: the target, the shortfall, the estimates (expenses) */
function AmountChips({
  view,
  model,
  fmt,
  currency,
  onPick,
}: Readonly<{ view: SubjectView; model: PlanningModel; fmt: MoneyFmt; currency: string; onPick: (cents: number) => void }>) {
  const { t } = useLang();
  const chips: AmountSuggestion[] = [];
  if (view.targetCents !== null && view.targetCents > 0) chips.push({ id: 'target', label: t('plan.fund.chipTarget'), cents: view.targetCents });
  if (view.realizedCents > view.fundedCents) chips.push({ id: 'spent', label: t('plan.fund.chipSpent'), cents: view.realizedCents });
  if (view.subject.segment === 'expenses') {
    const estimate = model.estimate(subjectFamily(view.subject, model.data.catalog));
    if (estimate.lastCents !== null) chips.push({ id: 'last', label: t('plan.subject.estimateLast'), cents: estimate.lastCents });
    if (estimate.averageCents !== null) chips.push({ id: 'avg', label: t('plan.subject.estimateAvg'), cents: estimate.averageCents });
  }
  return <AmountSuggestions items={chips} fmt={fmt} currency={currency} testIdPrefix="plan-fund-chip" onPick={onPick} />;
}

/** where to take money from: munni's picks first, then everybody with room */
export function CoverSheet({
  open,
  onOpenChange,
  model,
  plan,
  view,
  fmt,
  currency,
  onCover,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  model: PlanningModel;
  plan: PlanRow;
  view: SubjectView | null;
  fmt: MoneyFmt;
  currency: string;
  onCover: (fromId: string, cents: number) => void;
}>) {
  const { t } = useLang();
  if (!view) return null;
  const need = Math.max(view.realizedCents - view.fundedCents, shortfallCents(view), 0);
  const candidates = coverCandidates(model.viewsOf(plan), view.subject.id);
  const picks = new Set(candidates.picks.map((c) => c.subject.id));
  const others = candidates.all.filter((c) => !picks.has(c.subject.id));
  const row = (candidate: SubjectView) => {
    const spare = slackCents(candidate);
    const color = candidate.subject.color ?? SEGMENT_COLOR[candidate.subject.segment];
    return (
      <Row
        key={candidate.subject.id}
        kind="data"
        testId={`plan-cover-${candidate.subject.id}`}
        leading={<Tile icon={candidate.subject.icon ?? SEGMENT_META[candidate.subject.segment].icon} bg={softOf(color)} color={color} />}
        title={candidate.subject.name}
        sub={t('plan.cover.spare', { amount: fmt(spare, currency) })}
        trailing={<span className="m-num text-[13px] font-semibold text-ink">{fmt(Math.min(spare, need), currency)}</span>}
        chevron={false}
        onClick={() => onCover(candidate.subject.id, Math.min(spare, need))}
      />
    );
  };
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('plan.cover.title')} size="tall">
      <p className="mb-2 text-[12px] text-ink-3">{t('plan.cover.hint', { amount: fmt(need, currency) })}</p>
      <div data-testid="plan-cover-list">
        {candidates.all.length === 0 && <p className="py-4 text-center text-[13px] text-ink-4">{t('plan.cover.none')}</p>}
        {candidates.picks.length > 0 && <div className="m-cap mt-2 mb-1 px-1">{t('plan.cover.picks')}</div>}
        {candidates.picks.length > 0 && <div className="overflow-hidden rounded-card border border-line bg-surface">{candidates.picks.map(row)}</div>}
        {others.length > 0 && <div className="m-cap mt-3 mb-1 px-1">{t('plan.cover.others')}</div>}
        {others.length > 0 && <div className="overflow-hidden rounded-card border border-line bg-surface">{others.map(row)}</div>}
      </div>
    </Sheet>
  );
}

/**
 * A subject opened: set what it holds (typed or by chip), fill it to its
 * target, cover an overspend from another subject, snooze a mirrored
 * subject for the period, edit or remove an expense subject, or jump to
 * the source row. The previous period only moves money; older ones read.
 */
export function SubjectSheet({
  view,
  model,
  plan,
  editability,
  ops,
  fmt,
  currency,
  onClose,
  onEdit,
}: Readonly<{
  view: SubjectView | null;
  model: PlanningModel;
  plan: PlanRow;
  editability: PlanEditability;
  ops: PlanningOps;
  fmt: MoneyFmt;
  currency: string;
  onClose: () => void;
  onEdit: (subject: PlanSubjectRow) => void;
}>) {
  const { t } = useLang();
  const openSource = useOpenSource();
  const [draft, setDraft] = useState('');
  const [coverOpen, setCoverOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const subjectId = view?.subject.id;
  const funded = view?.fundedCents ?? 0;
  useEffect(() => {
    setDraft((funded / 100).toFixed(2));
  }, [subjectId, funded]);
  if (!view) return null;
  const { subject } = view;
  const canMove = editability !== 'readOnly';
  const canEdit = editability === 'full';
  const color = subject.color ?? SEGMENT_COLOR[subject.segment];
  const typed = parseCents(draft);
  const dirty = typed !== null && typed !== view.fundedCents;
  const save = async () => {
    if (typed === null) return;
    await ops.fund(subject.id, typed);
    onClose();
  };
  return (
    <>
      <Sheet
        open
        onOpenChange={(next) => !next && onClose()}
        title={subject.name}
        size="tall"
        footer={
          canMove ? (
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" data-testid="plan-fund-cancel" onClick={onClose}>
                {t('action.cancel')}
              </Button>
              <Button className="flex-1" data-testid="plan-fund-save" disabled={!dirty} onClick={() => void save()}>
                {t('action.save')}
              </Button>
            </div>
          ) : undefined
        }
      >
        <div className="flex flex-col gap-3" data-testid="plan-sheet">
          <div className="flex items-center gap-3">
            <Tile icon={subject.icon ?? SEGMENT_META[subject.segment].icon} size={48} bg={softOf(color)} color={color} />
            <div className="min-w-0 flex-1">
              <Pill tone={STATUS_TONE[view.status]} testId="plan-sheet-status">
                {statusLine(view, t, fmt, currency)}
              </Pill>
              <div className="mt-1 text-[12px] text-ink-3">
                {t('plan.fundedOf', { funded: fmt(view.fundedCents, currency), target: view.targetCents === null ? '—' : fmt(view.targetCents, currency) })}
                {' · '}
                {t('plan.spentShort', { amount: fmt(view.realizedCents, currency) })}
              </div>
              {view.carriedCents > 0 && <div className="text-[11px] text-ink-4">{t('plan.carriedNote', { amount: fmt(view.carriedCents, currency) })}</div>}
              {view.cycles > 1 && <div className="text-[11px] text-ink-4">{t('plan.cycles', { n: view.cycles })}</div>}
            </div>
          </div>
          {editability === 'readOnly' && (
            <p className="rounded-card bg-bg-2 px-3 py-2 text-[12px] text-ink-3" data-testid="plan-sheet-readonly">
              {t('plan.readOnly')}
            </p>
          )}
          {canMove && (
            <>
              <div className="m-cap px-1">{t('plan.fund.amount', { currency })}</div>
              <input
                data-testid="plan-fund-input"
                inputMode="decimal"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none"
              />
              <AmountChips view={view} model={model} fmt={fmt} currency={currency} onPick={(cents) => setDraft((cents / 100).toFixed(2))} />
              <div className="flex flex-wrap gap-2">
                {shortfallCents(view) > 0 && model.toAllocateOf(plan) > 0 && (
                  <Button size="sm" variant="outline" data-testid="plan-fund-fill" onClick={() => void ops.fillSubject(plan, subject.id).then(onClose)}>
                    {t('plan.fund.fill')}
                  </Button>
                )}
                {(view.status === 'overspent' || shortfallCents(view) > 0) && (
                  <Button size="sm" variant="outline" data-testid="plan-fund-cover" onClick={() => setCoverOpen(true)}>
                    {t('plan.cover.title')}
                  </Button>
                )}
                {canEdit && canSnooze(view) && (
                  <Button size="sm" variant="ghost" data-testid="plan-fund-snooze" onClick={() => void ops.snooze(subject.id, subject.snoozed !== 1).then(onClose)}>
                    {subject.snoozed === 1 ? t('plan.fund.unsnooze') : t('plan.fund.snooze')}
                  </Button>
                )}
              </div>
            </>
          )}
          <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
            {subject.sourceId && (
              <Row icon="open-in-app" title={t('plan.fund.openSource')} testId="plan-fund-open" onClick={() => openSource(subject)} />
            )}
            {canEdit && subject.segment === 'expenses' && (
              <Row icon="pencil-outline" title={t('plan.fund.edit')} testId="plan-fund-edit" onClick={() => onEdit(subject)} />
            )}
            {canEdit && (
              <Row icon="delete-outline" iconColor="var(--m-negative)" title={t('plan.subject.remove')} sub={t('plan.subject.removeNote')} testId="plan-fund-remove" chevron={false} onClick={() => setRemoveOpen(true)} />
            )}
          </div>
          {canMove && (
            <p className="flex items-start gap-2 text-[11px] text-ink-4">
              <Icon name="information-outline" size={14} />
              <span>{t('plan.fund.hint')}</span>
            </p>
          )}
        </div>
      </Sheet>
      <CoverSheet
        open={coverOpen}
        onOpenChange={setCoverOpen}
        model={model}
        plan={plan}
        view={view}
        fmt={fmt}
        currency={currency}
        onCover={(fromId, cents) => {
          void ops.cover(fromId, subject.id, cents).then(() => {
            setCoverOpen(false);
            onClose();
          });
        }}
      />
      <DangerConfirmSheet
        open={removeOpen}
        onOpenChange={setRemoveOpen}
        title={t('plan.subject.remove')}
        body={t('plan.subject.removeNote')}
        confirmLabel={t('action.delete')}
        cooldown={0}
        testId="plan-remove-confirm"
        onConfirm={() => {
          void ops.removeSubject(subject.id).then(() => {
            setRemoveOpen(false);
            onClose();
          });
        }}
      />
    </>
  );
}
