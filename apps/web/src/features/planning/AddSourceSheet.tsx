import { useLang } from '@/i18n';
import type { PlanRow, PlanSegmentKind } from '@/db/types';
import type { MirroredSource, PlanningModel, PlanningOps } from '@/application/planning';
import { isDebtTracked } from '@/domain/debts';
import { Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { SEGMENT_COLOR, SEGMENT_META, softOf } from './planningUi';

/** the rows a mirrored segment can still take: every live source not yet in the plan */
export function mirrorCandidates(model: PlanningModel, plan: PlanRow, segment: PlanSegmentKind): MirroredSource[] {
  const taken = new Set(model.subjectsOf(plan).filter((s) => s.segment === segment).map((s) => s.sourceId));
  const free = <T extends { id: string }>(rows: readonly T[]) => rows.filter((r) => !taken.has(r.id));
  switch (segment) {
    case 'recurring':
      return free(model.data.recurrings.filter((r) => r.active === 1)).map((r) => ({ id: r.id, name: r.name, icon: r.icon }));
    case 'debts':
      return free(model.data.accounts.filter((a) => a.archived !== 1 && isDebtTracked(a))).map((a) => ({ id: a.id, name: a.name, color: a.color }));
    case 'budgets':
      return free(model.data.budgets.filter((b) => b.active === 1)).map((b) => ({ id: b.id, name: b.name, icon: b.icon }));
    case 'goals':
      return free(model.data.goals.filter((g) => g.archived !== 1)).map((g) => ({ id: g.id, name: g.name, icon: g.icon, color: g.color }));
    default:
      return [];
  }
}

/** add a budget, recurring cost, loan or goal to the plan: it mirrors the source row */
export function AddSourceSheet({
  segment,
  model,
  plan,
  ops,
  onClose,
}: Readonly<{ segment: Exclude<PlanSegmentKind, 'expenses'> | null; model: PlanningModel; plan: PlanRow; ops: PlanningOps; onClose: () => void }>) {
  const { t } = useLang();
  if (!segment) return null;
  const candidates = mirrorCandidates(model, plan, segment);
  const meta = SEGMENT_META[segment];
  return (
    <Sheet open onOpenChange={(next) => !next && onClose()} title={t(meta.addKey)} size="tall">
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="plan-add-source">
        {candidates.length === 0 && <p className="px-4 py-4 text-center text-[13px] text-ink-4">{t('plan.addSourceNone')}</p>}
        {candidates.map((source) => {
          const color = source.color ?? SEGMENT_COLOR[segment];
          return (
            <Row
              key={source.id}
              kind="data"
              testId={`plan-add-source-${source.id}`}
              leading={<Tile icon={source.icon ?? meta.icon} bg={softOf(color)} color={color} />}
              title={source.name}
              chevron={false}
              onClick={() => void ops.addMirrored(plan.id, segment, source).then(onClose)}
            />
          );
        })}
      </div>
    </Sheet>
  );
}
