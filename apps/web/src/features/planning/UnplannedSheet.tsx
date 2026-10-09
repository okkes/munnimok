import { useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import type { PlanningModel } from '@/application/planning';
import type { UnplannedMain, UnplannedRow } from '@/domain/planning';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Icon } from '@/ui/Icon';
import { Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import type { MoneyFmt } from './SegmentSection';
import { SourceTile } from './SourceTile';
import { SEGMENT_META, UNPLANNED_SEGMENT } from './planningUi';

type UnplannedSource = Exclude<UnplannedRow, { kind: 'category' }>;

/** the amount pill of an unplanned row: spent for money that left, put aside for what a goal was given (user 2026-10-09) */
export function unplannedAmount(row: UnplannedRow, t: TFunc, fmt: MoneyFmt, currency: string): string {
  const amount = fmt(row.cents, currency);
  return row.kind === 'goal' ? t('plan.unplannedSaved', { amount }) : t('plan.unplannedSpent', { amount });
}

/** the category kind: what it spent by sub, and Plan it — the editor filled in with that spending as the target */
function CategoryBody({ row, fmt, currency, onPlan }: Readonly<{ row: UnplannedMain; fmt: MoneyFmt; currency: string; onPlan: () => void }>) {
  const { t } = useLang();
  const cats = useCategories();
  const main = cats.byId(row.mainId);
  const subs = row.subs.filter((s) => s.catId !== row.mainId);
  return (
    <>
      <div className="flex items-center gap-3">
        <Tile icon={main.icon} size={48} bg={`color-mix(in srgb, ${main.color} 14%, transparent)`} color={main.color} />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-negative" data-testid="plan-unplanned-sheet-spent">
            {t('plan.unplannedSpent', { amount: fmt(row.cents, currency) })}
          </div>
          {subs.length > 0 && (
            <div className="mt-0.5 text-[11px] text-ink-4">{subs.map((s) => `${catName(cats.byId(s.catId), t)} ${fmt(s.cents, currency)}`).join(' · ')}</div>
          )}
        </div>
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <Row icon="pencil-outline" title={t('plan.unplannedPlan')} sub={t('plan.unplannedPlanSub')} testId="plan-unplanned-plan" onClick={onPlan} />
      </div>
      <p className="flex items-start gap-2 text-[11px] text-ink-4" data-testid="plan-unplanned-sheet-hint">
        <Icon name="information-outline" size={14} />
        <span>{t('plan.unplannedPlanHint')}</span>
      </p>
    </>
  );
}

/**
 * A source kind (user 2026-10-09): what the recurring cost, loan or goal
 * took this period, and Plan it — the mirrored subject added as it is, no
 * editor; the hint says which segment takes it and that the money already
 * spent is counted there (the head does not move).
 */
function SourceBody({ row, model, fmt, currency, onMirror }: Readonly<{ row: UnplannedSource; model: PlanningModel; fmt: MoneyFmt; currency: string; onMirror: () => void }>) {
  const { t } = useLang();
  const segment = UNPLANNED_SEGMENT[row.kind];
  const vars = { name: row.name, segment: t(SEGMENT_META[segment].labelKey) };
  return (
    <>
      <div className="flex items-center gap-3">
        <SourceTile
          segment={segment}
          sourceId={row.sourceId}
          icon={row.kind === 'debt' ? undefined : row.icon}
          color={row.kind === 'recurring' ? undefined : row.color}
          model={model}
          size={48}
          testId={`plan-unplanned-sheet-logo-${row.sourceId}`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] text-negative" data-testid="plan-unplanned-sheet-spent">
            {unplannedAmount(row, t, fmt, currency)}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-4">{row.kind === 'goal' ? t('plan.unplannedGoalLine') : t('plan.unplannedSourceLine')}</div>
        </div>
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <Row icon="plus-circle-outline" title={t('plan.unplannedPlan')} sub={t('plan.unplannedMirrorSub')} testId="plan-unplanned-plan" onClick={onMirror} />
      </div>
      <p className="flex items-start gap-2 text-[11px] text-ink-4" data-testid="plan-unplanned-sheet-hint">
        <Icon name="information-outline" size={14} />
        <span>{row.kind === 'goal' ? t('plan.unplannedMirrorHintGoal', vars) : t('plan.unplannedMirrorHint', vars)}</span>
      </p>
    </>
  );
}

/**
 * An unplanned row opened. A main: what it spent, by sub, and the one door —
 * Plan it (the editor, filled in with the spending as the target). The "Set
 * aside" amount it used to carry is gone (user 2026-10-08: "I just don't
 * know what it will do"): what was spent here already counts in the pool,
 * so the person plans the subject and then funds it to cover the spending.
 * A source row (user 2026-10-09) plans itself: Plan it adds the mirrored
 * subject straight away.
 */
export function UnplannedSheet({
  row,
  model,
  fmt,
  currency,
  onPlan,
  onMirror,
  onClose,
}: Readonly<{
  row: UnplannedRow | null;
  model: PlanningModel;
  fmt: MoneyFmt;
  currency: string;
  onPlan: (row: UnplannedMain) => void;
  onMirror: (row: UnplannedSource) => void;
  onClose: () => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  if (!row) return null;
  const title = row.kind === 'category' ? catName(cats.byId(row.mainId), t) : row.name;
  return (
    <Sheet open onOpenChange={(next) => !next && onClose()} title={title} size="form">
      <div className="flex flex-col gap-3" data-testid="plan-unplanned-sheet">
        {row.kind === 'category' ? (
          <CategoryBody row={row} fmt={fmt} currency={currency} onPlan={() => onPlan(row)} />
        ) : (
          <SourceBody row={row} model={model} fmt={fmt} currency={currency} onMirror={() => onMirror(row)} />
        )}
      </div>
    </Sheet>
  );
}
