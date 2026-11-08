import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import { useData } from '@/app/data';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { unplannedKey } from '@/domain/planning';
import type { UnplannedMain, UnplannedRow } from '@/domain/planning';
import { catName, useCategories } from '@/features/categories/useCategories';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Row, Tile } from '@/ui/primitives';
import type { Tone } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { AmountSuggestions } from './AmountSuggestions';
import { OverBudgetSheet, useOverBudgetGuard } from './overBudget';
import type { MoneyFmt } from './SegmentSection';
import { SourceTile } from './SourceTile';
import { SEGMENT_META, UNPLANNED_SEGMENT } from './planningUi';

type UnplannedSource = Exclude<UnplannedRow, { kind: 'category' }>;

/** the amount pill of an unplanned row: spent for money that left, put aside for what a goal was given (user 2026-10-09) */
export function unplannedAmount(row: UnplannedRow, t: TFunc, fmt: MoneyFmt, currency: string): string {
  const amount = fmt(row.cents, currency);
  return row.kind === 'goal' ? t('plan.unplannedSaved', { amount }) : t('plan.unplannedSpent', { amount });
}

/**
 * A row funded for this period only (#494) reads like a subject: red while
 * the money given falls short of what it spent, green once it covers it.
 * Unfunded, it stays the plain red amount of money nothing answers for.
 */
export function unplannedPill(row: UnplannedRow, t: TFunc, fmt: MoneyFmt, currency: string): { tone: Tone; text: string } {
  const funded = row.fundedCents ?? 0;
  if (funded <= 0) return { tone: 'negative', text: unplannedAmount(row, t, fmt, currency) };
  if (row.cents > funded) return { tone: 'negative', text: t('plan.status.overspent', { amount: fmt(row.cents - funded, currency) }) };
  return { tone: 'accent', text: t('plan.oneOff.funded', { amount: fmt(funded, currency) }) };
}

/** #494 (user 2026-10-14): money for this row for this period only — it never becomes a subject, so next period it is gone */
function OneOffFunding({
  row,
  model,
  plan,
  ops,
  fmt,
  currency,
  onDone,
}: Readonly<{ row: UnplannedRow; model: PlanningModel; plan: PlanRow; ops: PlanningOps; fmt: MoneyFmt; currency: string; onDone: () => void }>) {
  const { t } = useLang();
  const { spaceId } = useData();
  const overBudget = useOverBudgetGuard(spaceId);
  const funded = row.fundedCents ?? 0;
  const [draft, setDraft] = useState((funded / 100).toFixed(2));
  useEffect(() => setDraft((funded / 100).toFixed(2)), [funded]);
  const typed = parseCents(draft);
  const dirty = typed !== null && typed >= 0 && typed !== funded;
  const save = () => {
    if (typed === null) return;
    // beyond the pool asks once a day, as every funding door does
    overBudget.guard(model.toAllocateOf(plan), typed - funded, () => void ops.fundOneOff(plan, unplannedKey(row), typed).then(onDone));
  };
  return (
    <div className="flex flex-col gap-2" data-testid="plan-oneoff">
      <div className="m-cap px-1">{t('plan.oneOff.title', { currency })}</div>
      <div className="flex gap-2">
        <input
          data-testid="plan-oneoff-input"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-11 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none"
        />
        <Button size="sm" data-testid="plan-oneoff-save" disabled={!dirty} onClick={save}>
          {t('action.save')}
        </Button>
      </div>
      <AmountSuggestions
        items={row.cents > 0 ? [{ id: 'spent', label: t('plan.fund.chipSpent'), cents: row.cents }] : []}
        fmt={fmt}
        currency={currency}
        testIdPrefix="plan-oneoff-chip"
        selectedCents={typed}
        onPick={(cents) => setDraft((cents / 100).toFixed(2))}
      />
      <p className="px-1 text-[11px] text-ink-4" data-testid="plan-oneoff-hint">
        {t('plan.oneOff.hint')}
      </p>
      <OverBudgetSheet guard={overBudget} fmt={fmt} currency={currency} />
    </div>
  );
}

/** the category kind: what it spent by sub, the funding for this period, and Plan it — the editor filled in with that spending as the target */
function CategoryBody({
  row,
  fmt,
  currency,
  funding,
  onPlan,
}: Readonly<{ row: UnplannedMain; fmt: MoneyFmt; currency: string; funding: ReactNode; onPlan: (() => void) | null }>) {
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
      {funding}
      {onPlan && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <Row icon="pencil-outline" title={t('plan.unplannedPlan')} sub={t('plan.unplannedPlanSub')} testId="plan-unplanned-plan" onClick={onPlan} />
        </div>
      )}
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
function SourceBody({
  row,
  model,
  fmt,
  currency,
  funding,
  onMirror,
}: Readonly<{ row: UnplannedSource; model: PlanningModel; fmt: MoneyFmt; currency: string; funding: ReactNode; onMirror: (() => void) | null }>) {
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
      {funding}
      {onMirror && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <Row icon="plus-circle-outline" title={t('plan.unplannedPlan')} sub={t('plan.unplannedMirrorSub')} testId="plan-unplanned-plan" onClick={onMirror} />
        </div>
      )}
      <p className="flex items-start gap-2 text-[11px] text-ink-4" data-testid="plan-unplanned-sheet-hint">
        <Icon name="information-outline" size={14} />
        <span>{row.kind === 'goal' ? t('plan.unplannedMirrorHintGoal', vars) : t('plan.unplannedMirrorHint', vars)}</span>
      </p>
    </>
  );
}

/**
 * An unplanned row opened: what it spent (a main by sub), the money for this
 * period only (#494, user 2026-10-14: "a one time payment I don't want in the
 * plan that impacts the future") and Plan it — the editor filled in with the
 * spending as the target for a main, the mirrored subject straight away for
 * a source (user 2026-10-09). Planning it takes the period's money along.
 * The previous period moves money only, so it funds but does not plan.
 */
export function UnplannedSheet({
  row,
  model,
  plan,
  ops,
  canPlan,
  fmt,
  currency,
  onPlan,
  onMirror,
  onClose,
}: Readonly<{
  row: UnplannedRow | null;
  model: PlanningModel;
  plan: PlanRow;
  ops: PlanningOps;
  /** a fully editable plan: Plan it is offered */
  canPlan: boolean;
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
  const funding = <OneOffFunding row={row} model={model} plan={plan} ops={ops} fmt={fmt} currency={currency} onDone={onClose} />;
  return (
    <Sheet open onOpenChange={(next) => !next && onClose()} title={title} size="tall">
      <div className="flex flex-col gap-3" data-testid="plan-unplanned-sheet">
        {row.kind === 'category' ? (
          <CategoryBody row={row} fmt={fmt} currency={currency} funding={funding} onPlan={canPlan ? () => onPlan(row) : null} />
        ) : (
          <SourceBody row={row} model={model} fmt={fmt} currency={currency} funding={funding} onMirror={canPlan ? () => onMirror(row) : null} />
        )}
      </div>
    </Sheet>
  );
}
