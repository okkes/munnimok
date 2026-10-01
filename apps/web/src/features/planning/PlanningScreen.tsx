import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { usePlanning, usePlanningOps } from '@/application/planning';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import type { PlanRow, PlanSegmentKind, PlanSubjectRow } from '@/db/types';
import type { SubjectView } from '@/domain/planning';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { attachScrollMemory } from '@/lib/scrollMemory';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Pill, Row } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { AddSourceSheet } from './AddSourceSheet';
import { AheadSheet, aheadDiffers, periodLabel } from './AheadSheet';
import { BlueprintsSheet } from './BlueprintsSheet';
import { InsightsSheet } from './InsightsSheet';
import { PlanHeader } from './PlanHeader';
import { PoolSheet } from './PoolSheet';
import { ReorderSheet } from './ReorderSheet';
import { SegmentSection } from './SegmentSection';
import { SegmentsSheet } from './SegmentsSheet';
import { StartPlanCard } from './StartPlanCard';
import { SubjectEditor } from './SubjectEditor';
import { SubjectSheet } from './SubjectSheet';
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

/** the actual plan of the viewed period, or the sandbox beside the current one */
function viewedPlan(model: PlanningModel, viewBack: number, sandboxMode: boolean): PlanRow | null {
  if (viewBack === 0) return sandboxMode && model.sandbox ? model.sandbox : model.plan;
  const period = model.pastPeriods.at(-viewBack);
  return period ? (model.pastPlans.find((p) => p.periodStart === period.start) ?? null) : null;
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

/** the period pager: the current period, the previous one (money moves), older ones (reading) */
function PeriodPager({ model, viewBack, onViewBack }: Readonly<{ model: PlanningModel; viewBack: number; onViewBack: (next: number) => void }>) {
  const { lang } = useLang();
  const period = viewBack === 0 ? model.period : model.pastPeriods.at(-viewBack)!;
  return (
    <div className="flex items-center justify-between">
      <IconButton label="‹" testId="plan-prev" onClick={() => onViewBack(Math.min(viewBack + 1, model.pastPeriods.length))}>
        <Icon name="chevron-left" size={20} />
      </IconButton>
      <span className="text-[13px] font-medium text-ink-2" data-testid="plan-period">
        {periodLabel(period, lang)}
      </span>
      <IconButton label="›" testId="plan-next" onClick={() => onViewBack(Math.max(viewBack - 1, 0))}>
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
  const [editing, setEditing] = useState<PlanSubjectRow | 'new' | null>(null);
  const [adding, setAdding] = useState<Exclude<PlanSegmentKind, 'expenses'> | null>(null);

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
          canFill={canFill && model.toAllocateOf(plan) > 0}
          fmt={fmt}
          currency={currency}
          onFill={() => void ops.fillSegment(plan, s.kind)}
          onAdd={() => (s.kind === 'expenses' ? setEditing('new') : setAdding(s.kind))}
          onOpen={(view) => setOpenSubjectId(view.subject.id)}
        />
      ));
  };

  const body = () => {
    if (!model) return null;
    if (!plan) {
      return viewBack === 0 ? (
        <StartPlanCard model={model} ops={ops} currency={currency} />
      ) : (
        <p className="py-8 text-center text-[13px] text-ink-4" data-testid="plan-nopast">
          {t('plan.noPlanPast')}
        </p>
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
                setEditing(subject);
              }}
            />
          )}
          {editing !== null && (
            <SubjectEditor
              open
              onOpenChange={(next) => !next && setEditing(null)}
              subject={editing === 'new' ? null : editing}
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
