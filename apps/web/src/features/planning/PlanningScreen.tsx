import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { usePlanning, usePlanningOps } from '@/application/planning';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import type { PlanRow, PlanSegmentKind, PlanSubjectRow } from '@/db/types';
import { periodsAhead, shortfallCents } from '@/domain/planning';
import type { SubjectView, UnplannedMain } from '@/domain/planning';
import type { Period } from '@/domain/periods';
import { parseLocalDate } from '@/application/planningModel';
import { catName, useCategories } from '@/features/categories/useCategories';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { attachScrollMemory } from '@/lib/scrollMemory';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Pill, Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { AddSourceSheet } from './AddSourceSheet';
import { AheadSheet, aheadDiffers, periodLabel } from './AheadSheet';
import { BlueprintsSheet } from './BlueprintsSheet';
import { InsightsSheet } from './InsightsSheet';
import { PlanHeader } from './PlanHeader';
import { PoolSheet } from './PoolSheet';
import { ReorderSheet } from './ReorderSheet';
import { OverBudgetSheet, useOverBudgetGuard } from './overBudget';
import { SegmentSection } from './SegmentSection';
import { readFolds, toggleFold, writeFolds } from './segmentFolds';
import { SegmentsSheet } from './SegmentsSheet';
import { StartPlanCard } from './StartPlanCard';
import { SubjectEditor } from './SubjectEditor';
import type { EditorPreset } from './SubjectEditor';
import { SubjectSheet } from './SubjectSheet';
import { UnplannedSheet } from './UnplannedSheet';
import { SEGMENT_META } from './planningUi';

type MenuItem = 'blueprints' | 'sandbox' | 'segments' | 'reorder' | 'pool' | 'insights';
const MENU: { id: MenuItem; icon: string; key: 'plan.menu.blueprints' | 'plan.menu.sandbox' | 'plan.menu.segments' | 'plan.menu.reorder' | 'plan.menu.pool' | 'plan.menu.insights' }[] = [
  { id: 'blueprints', icon: 'content-copy', key: 'plan.menu.blueprints' },
  { id: 'sandbox', icon: 'flask-outline', key: 'plan.menu.sandbox' },
  { id: 'segments', icon: 'view-sequential-outline', key: 'plan.menu.segments' },
  { id: 'reorder', icon: 'sort-variant', key: 'plan.menu.reorder' },
  { id: 'pool', icon: 'bank-outline', key: 'plan.menu.pool' },
  { id: 'insights', icon: 'chart-line', key: 'plan.menu.insights' },
];

/** how far the pager walks into the future (the funded periods ahead and the empty ones after them) */
const MAX_AHEAD = 12;

/** the n-th period after the current one */
const aheadPeriodAt = (model: PlanningModel, n: number): Period =>
  periodsAhead(model.data.space ?? { periodType: 'month', periodDay: 1 }, n, parseLocalDate(model.today))[n - 1];

/** the period the pager shows: the current one, one of the past, or one ahead (negative) */
const viewedPeriod = (model: PlanningModel, viewBack: number): Period => {
  if (viewBack === 0) return model.period;
  if (viewBack > 0) return model.pastPeriods.at(-viewBack) ?? model.period;
  return aheadPeriodAt(model, -viewBack);
};

/** the actual plan of the viewed period, or the sandbox beside the current one */
function viewedPlan(model: PlanningModel, viewBack: number, sandboxMode: boolean): PlanRow | null {
  if (viewBack === 0) return sandboxMode && model.sandbox ? model.sandbox : model.plan;
  const period = viewedPeriod(model, viewBack);
  if (viewBack > 0) return model.pastPlans.find((p) => p.periodStart === period.start) ?? null;
  return model.ahead.find((a) => a.period.start === period.start)?.plan ?? null;
}

/** the spending no subject answers for, by main — a row opens the sheet that funds it or plans it (user 2026-10-07) */
function UnplannedSection({
  rows,
  fmt,
  currency,
  onOpen,
}: Readonly<{ rows: UnplannedMain[]; fmt: (cents: number, currency: string) => string; currency: string; onOpen: (row: UnplannedMain) => void }>) {
  const { t } = useLang();
  const cats = useCategories();
  if (rows.length === 0) return null;
  const total = rows.reduce((sum, r) => sum + r.cents, 0);
  return (
    <section data-testid="plan-segment-unplanned" className="mt-5">
      <div className="m-cap mb-1 flex items-center justify-between gap-2 px-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <Icon name="help-circle-outline" size={14} />
          <span className="truncate">{t('plan.segment.unplanned')}</span>
          <span className="m-num font-normal normal-case text-negative" data-testid="plan-segment-total-unplanned">
            {fmt(total, currency)}
          </span>
        </span>
      </div>
      <p className="mb-1 px-1 text-[11px] text-ink-4">{t('plan.unplannedHint')}</p>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {rows.map((row) => {
          const main = cats.byId(row.mainId);
          const subs = row.subs.filter((s) => s.catId !== row.mainId);
          return (
            <button
              type="button"
              key={row.mainId}
              onClick={() => onOpen(row)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
              data-testid={`plan-unplanned-${row.mainId}`}
            >
              <Tile icon={main.icon} bg={`color-mix(in srgb, ${main.color} 14%, transparent)`} color={main.color} />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{catName(main, t)}</span>
                  <Pill tone="negative">{t('plan.unplannedSpent', { amount: fmt(row.cents, currency) })}</Pill>
                </span>
                {subs.length > 0 && (
                  <span className="mt-0.5 block truncate text-[11px] text-ink-4">
                    {subs.map((s) => `${catName(cats.byId(s.catId), t)} ${fmt(s.cents, currency)}`).join(' · ')}
                  </span>
                )}
              </span>
              <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** the sandbox strip: actual ↔ sandbox, and the sandbox's three verbs */
function SandboxStrip({
  model,
  sandboxMode,
  onMode,
  ops,
}: Readonly<{ model: PlanningModel; sandboxMode: boolean; onMode: (sandbox: boolean) => void; ops: PlanningOps }>) {
  const { t } = useLang();
  const [discarding, setDiscarding] = useState(false);
  if (!model.sandbox) return null;
  const seg = (id: 'actual' | 'sandbox', label: string) => {
    const on = (id === 'sandbox') === sandboxMode;
    return (
      <button
        data-testid={`plan-mode-${id}`}
        aria-pressed={on}
        onClick={() => onMode(id === 'sandbox')}
        className={`m-tap flex-1 rounded-lg border-none py-1.5 text-[12px] font-medium ${on ? 'bg-surface text-ink shadow-sm' : 'bg-transparent text-ink-3'}`}
      >
        {label}
      </button>
    );
  };
  return (
    <div className="mt-3" data-testid="plan-sandbox-strip">
      <div className="flex rounded-xl bg-bg-2 p-0.5">
        {seg('actual', t('plan.sandbox.actual'))}
        {seg('sandbox', t('plan.sandbox.badge'))}
      </div>
      {sandboxMode && (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button size="sm" data-testid="plan-sandbox-finalize" onClick={() => void ops.finalizeSandbox().then(() => onMode(false))}>
            {t('plan.sandbox.finalize')}
          </Button>
          <Button size="sm" variant="outline" data-testid="plan-sandbox-reset" onClick={() => void ops.resetSandbox()}>
            {t('plan.sandbox.reset')}
          </Button>
          <Button size="sm" variant="ghost" data-testid="plan-sandbox-discard" onClick={() => setDiscarding(true)}>
            {t('plan.sandbox.delete')}
          </Button>
        </div>
      )}
      <DangerConfirmSheet
        open={discarding}
        onOpenChange={setDiscarding}
        title={t('plan.sandbox.delete')}
        body={t('plan.sandbox.deleteBody')}
        confirmLabel={t('plan.sandbox.delete')}
        cooldown={0}
        testId="plan-sandbox-discard-confirm"
        onConfirm={() => {
          void ops.deleteSandbox().then(() => {
            setDiscarding(false);
            onMode(false);
          });
        }}
      />
    </div>
  );
}

/** the period pager: the past (reading, the previous one moving money), the current period, the periods ahead */
function PeriodPager({ model, viewBack, onViewBack }: Readonly<{ model: PlanningModel; viewBack: number; onViewBack: (next: number) => void }>) {
  const { lang } = useLang();
  const period = viewedPeriod(model, viewBack);
  return (
    <div className="flex items-center justify-between">
      <IconButton label="‹" testId="plan-prev" onClick={() => onViewBack(Math.min(viewBack + 1, model.pastPeriods.length))}>
        <Icon name="chevron-left" size={20} />
      </IconButton>
      <span className="text-[13px] font-medium text-ink-2" data-testid="plan-period">
        {periodLabel(period, lang)}
      </span>
      <IconButton label="›" testId="plan-next" onClick={() => onViewBack(Math.max(viewBack - 1, -MAX_AHEAD))}>
        <Icon name="chevron-right" size={20} />
      </IconButton>
    </div>
  );
}

/**
 * Planning (#128): money gets a job before it is spent. The pool (the
 * checking and cash balances) is handed out to the plan's subjects —
 * recurring costs and debts first, then your own expenses, budgets and
 * goals — and what each subject holds is read against what it needs and
 * what was spent. Periods ahead fill from what is left; blueprints keep a
 * shape; the sandbox is a copy to try things in.
 */
export function PlanningScreen() {
  const { t } = useLang();
  const { store, spaceId } = useData();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const { fmt } = useDisplayMoney();
  const currency = space?.currency ?? 'EUR';
  const model = usePlanning();
  const ops = usePlanningOps();

  const [viewBack, setViewBack] = useState(0);
  const [sandboxMode, setSandboxMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [sheet, setSheet] = useState<MenuItem | 'ahead' | null>(null);
  const [reorderSegment, setReorderSegment] = useState<PlanSegmentKind | null>(null);
  const [openSubjectId, setOpenSubjectId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ subject: PlanSubjectRow | null; preset?: EditorPreset } | null>(null);
  const [adding, setAdding] = useState<Exclude<PlanSegmentKind, 'expenses'> | null>(null);
  const [unplannedOpen, setUnplannedOpen] = useState<UnplannedMain | null>(null);
  const cats = useCategories();
  const overBudget = useOverBudgetGuard(spaceId);
  // which segments are folded: this device remembers (user 2026-10-07)
  const [folds, setFolds] = useState<Set<PlanSegmentKind>>(() => readFolds(spaceId));
  const toggleSegmentFold = (kind: PlanSegmentKind) =>
    setFolds((prev) => {
      const next = toggleFold(prev, kind);
      writeFolds(spaceId, next);
      return next;
    });

  const plan = useMemo(() => (model ? viewedPlan(model, viewBack, sandboxMode) : null), [model, viewBack, sandboxMode]);
  const views = useMemo(() => (model && plan ? model.viewsOf(plan) : []), [model, plan]);
  const openView: SubjectView | null = views.find((v) => v.subject.id === openSubjectId) ?? null;
  const editability = model && plan ? model.editabilityOf(plan) : 'readOnly';
  const editable = editability === 'full';
  const canFill = editability !== 'readOnly';

  const pick = (item: MenuItem) => {
    setMenuOpen(false);
    if (item === 'sandbox') {
      if (model?.sandbox) setSandboxMode(true);
      else void ops.createSandbox().then(() => setSandboxMode(true));
      return;
    }
    setSheet(item);
  };

  // the one-tap funding doors (user 2026-10-07): a segment to its targets, a subject to its target —
  // each through the beyond-the-pool guard with what the pool would still have to give
  const needOf = (kind: PlanSegmentKind): number =>
    views.filter((v) => v.subject.segment === kind && v.subject.snoozed !== 1).reduce((sum, v) => sum + shortfallCents(v), 0);
  const fundSegment = (kind: PlanSegmentKind) => {
    if (!model || !plan) return;
    overBudget.guard(model.toAllocateOf(plan), needOf(kind), () => void ops.fundSegment(plan, kind));
  };
  const fundToTarget = (view: SubjectView) => {
    if (!model || !plan) return;
    const need = shortfallCents(view);
    overBudget.guard(model.toAllocateOf(plan), need, () => void ops.fund(view.subject.id, view.fundedCents + need));
  };

  const segmentBlocks = () => {
    if (!model || !plan) return null;
    return model
      .segmentsOf(plan)
      .filter((s) => s.hidden !== 1)
      .map((s) => (
        <SegmentSection
          key={s.kind}
          kind={s.kind}
          views={views.filter((v) => v.subject.segment === s.kind)}
          editable={editable}
          canFill={canFill}
          fmt={fmt}
          currency={currency}
          onFill={() => fundSegment(s.kind)}
          onFundToTarget={fundToTarget}
          onAdd={() => (s.kind === 'expenses' ? setEditing({ subject: null }) : setAdding(s.kind))}
          onOpen={(view) => setOpenSubjectId(view.subject.id)}
          folded={folds.has(s.kind)}
          onToggleFold={() => toggleSegmentFold(s.kind)}
        />
      ));
  };

  const body = () => {
    if (!model) return null;
    if (!plan) {
      if (viewBack === 0) return <StartPlanCard model={model} ops={ops} currency={currency} />;
      if (viewBack > 0) {
        return (
          <p className="py-8 text-center text-[13px] text-ink-4" data-testid="plan-nopast">
            {t('plan.noPlanPast')}
          </p>
        );
      }
      // a period ahead without a plan yet: it takes the current shape and what is left (user request 2026-10-02)
      return (
        <div className="rounded-card border border-line bg-surface p-4 text-center" data-testid="plan-ahead-empty">
          <p className="text-[13px] text-ink-3">{t('plan.aheadEmpty')}</p>
          {model.plan ? (
            <Button size="sm" className="mt-3" data-testid="plan-ahead-start" onClick={() => void ops.fundAhead(viewedPeriod(model, viewBack))}>
              {t('plan.aheadStart')}
            </Button>
          ) : (
            <p className="mt-2 text-[11px] text-ink-4">{t('plan.aheadNeedsCurrent')}</p>
          )}
        </div>
      );
    }
    return (
      <>
        <PlanHeader
          model={model}
          plan={plan}
          editable={canFill}
          fmt={fmt}
          currency={currency}
          onFillAll={() => void ops.fillAll(plan)}
          onWithdrawAll={() => void ops.withdrawAll(plan)}
          onAhead={() => setSheet('ahead')}
        />
        {editability === 'moveOnly' && (
          <p className="mt-2 px-1 text-center text-[11px] text-ink-4" data-testid="plan-moveonly">
            {t('plan.previous')}
          </p>
        )}
        {editability === 'readOnly' && (
          <p className="mt-2 px-1 text-center text-[11px] text-ink-4" data-testid="plan-readonly">
            {t('plan.readOnly')}
          </p>
        )}
        {viewBack === 0 && <SandboxStrip model={model} sandboxMode={sandboxMode} onMode={setSandboxMode} ops={ops} />}
        {viewBack === 0 && plan.kind === 'actual' && aheadDiffers(model, plan) && (
          <button
            data-testid="plan-ahead-differs-strip"
            onClick={() => setSheet('ahead')}
            className="m-tap mt-3 flex w-full items-center gap-2 rounded-card bg-bg-2 px-3 py-2 text-left text-[12px] text-ink-2"
          >
            <Icon name="calendar-sync-outline" size={16} color="var(--m-accent-deep)" />
            <span className="min-w-0 flex-1">{t('plan.applyAheadHint')}</span>
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        )}
        {model.attention.length > 0 && plan.kind === 'actual' && viewBack === 0 && (
          <div className="mt-3 px-1" data-testid="plan-attention">
            <Pill tone="negative">{t('plan.home.red', { n: model.attention.length })}</Pill>
          </div>
        )}
        {segmentBlocks()}
        {plan.kind !== 'blueprint' && viewBack >= 0 && (
          <UnplannedSection rows={model.unplannedOf(plan)} fmt={fmt} currency={currency} onOpen={setUnplannedOpen} />
        )}
      </>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-planning">
      <AppBar
        large
        title={t('plan.title')}
        trailing={
          <>
            <HelpButton tourId="planning" />
            {model?.plan && (
              <IconButton label={t('plan.menu.title')} testId="plan-menu" onClick={() => setMenuOpen(true)}>
                <Icon name="dots-vertical" size={22} />
              </IconButton>
            )}
          </>
        }
      />
      <div ref={(el) => attachScrollMemory(el, 'planning')} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <IntroCard tourId="planning" />
        {model && <PeriodPager model={model} viewBack={viewBack} onViewBack={setViewBack} />}
        {body()}
      </div>

      <Sheet open={menuOpen} onOpenChange={setMenuOpen} title={t('plan.menu.title')} size="form">
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="plan-menu-sheet">
          {MENU.map((item) => (
            <Row key={item.id} icon={item.icon} title={t(item.key)} testId={`plan-menu-${item.id}`} onClick={() => pick(item.id)} />
          ))}
        </div>
      </Sheet>
      <Sheet open={sheet === 'reorder'} onOpenChange={(next) => !next && setSheet(null)} title={t('plan.menu.reorder')} size="form">
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {model && plan &&
            model
              .segmentsOf(plan)
              .filter((s) => s.hidden !== 1)
              .map((s) => (
                <Row
                  key={s.kind}
                  icon={SEGMENT_META[s.kind].icon}
                  title={t(SEGMENT_META[s.kind].labelKey)}
                  testId={`plan-reorder-${s.kind}`}
                  onClick={() => {
                    setSheet(null);
                    setReorderSegment(s.kind);
                  }}
                />
              ))}
        </div>
      </Sheet>

      {model && plan && (
        <>
          <AheadSheet open={sheet === 'ahead'} onOpenChange={(next) => !next && setSheet(null)} model={model} plan={model.plan ?? plan} ops={ops} fmt={fmt} currency={currency} />
          <BlueprintsSheet open={sheet === 'blueprints'} onOpenChange={(next) => !next && setSheet(null)} model={model} plan={plan} ops={ops} />
          <SegmentsSheet open={sheet === 'segments'} onOpenChange={(next) => !next && setSheet(null)} model={model} plan={plan} ops={ops} />
          <PoolSheet open={sheet === 'pool'} onOpenChange={(next) => !next && setSheet(null)} model={model} ops={ops} fmt={fmt} currency={currency} />
          <InsightsSheet open={sheet === 'insights'} onOpenChange={(next) => !next && setSheet(null)} model={model} fmt={fmt} currency={currency} />
          <ReorderSheet segment={reorderSegment} model={model} plan={plan} ops={ops} onClose={() => setReorderSegment(null)} />
          <AddSourceSheet segment={adding} model={model} plan={plan} ops={ops} onClose={() => setAdding(null)} />
          <UnplannedSheet
            row={editable ? unplannedOpen : null}
            left={model.toAllocateOf(plan)}
            guard={overBudget}
            fmt={fmt}
            currency={currency}
            onFund={async (row, cents) => {
              const main = cats.byId(row.mainId);
              // born funded by what the period already paid; anything above that is what the pool gives (user 2026-10-07)
              const id = await ops.addExpense(plan.id, { name: catName(main, t), icon: main.icon, color: main.color, catIds: [row.mainId], targetCents: 0 });
              if (cents > row.cents) await ops.fund(id, cents);
              setUnplannedOpen(null);
            }}
            onPlan={(row) => {
              const main = cats.byId(row.mainId);
              setUnplannedOpen(null);
              setEditing({ subject: null, preset: { name: catName(main, t), icon: main.icon, color: main.color, catIds: [row.mainId], targetCents: row.cents } });
            }}
            onClose={() => setUnplannedOpen(null)}
          />
          <OverBudgetSheet guard={overBudget} fmt={fmt} currency={currency} />
          {openView && (
            <SubjectSheet
              view={openView}
              model={model}
              plan={plan}
              editability={editability}
              ops={ops}
              fmt={fmt}
              currency={currency}
              onClose={() => setOpenSubjectId(null)}
              onEdit={(subject) => {
                setOpenSubjectId(null);
                setEditing({ subject });
              }}
            />
          )}
          {editing !== null && (
            <SubjectEditor
              open
              onOpenChange={(next) => !next && setEditing(null)}
              subject={editing.subject}
              preset={editing.preset ?? null}
              plan={plan}
              model={model}
              ops={ops}
              fmt={fmt}
              currency={currency}
            />
          )}
        </>
      )}
    </div>
  );
}
