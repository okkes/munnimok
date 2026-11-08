import { useEffect, useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanRow, PlanSegmentKind } from '@/db/types';
import type { MirroredSource, PlanningModel, PlanningOps } from '@/application/planning';
import { budgetFamily } from '@/domain/budgets';
import { isDebtTracked } from '@/domain/debts';
import { isEventPast, overlapsOf } from '@/domain/planning';
import type { Overlap } from '@/domain/planning';
import { catName } from '@/features/categories/useCategories';
import { Icon } from '@/ui/Icon';
import { Button } from '@/ui/Button';
import { SelectAllRow } from '@/ui/SelectAllRow';
import { Sheet } from '@/ui/Sheet';
import { SourceTile } from './SourceTile';
import { SEGMENT_META } from './planningUi';

/** the rows a mirrored segment can still take: every live source not yet in the plan */
export function mirrorCandidates(model: PlanningModel, plan: PlanRow, segment: PlanSegmentKind): MirroredSource[] {
  const taken = new Set(model.subjectsOf(plan).filter((s) => s.segment === segment).map((s) => s.sourceId));
  const free = <T extends { id: string }>(rows: readonly T[]) => rows.filter((r) => !taken.has(r.id));
  switch (segment) {
    case 'recurring':
      return free(model.data.recurrings.filter((r) => r.active === 1)).map((r) => ({ id: r.id, name: r.name, icon: r.icon }));
    case 'debts':
      // a card in the money pool is the pool's own money (#532), never a debt to plan
      return free(model.data.accounts.filter((a) => a.archived !== 1 && isDebtTracked(a) && !model.poolIds.has(a.id))).map((a) => ({ id: a.id, name: a.name, color: a.color }));
    case 'budgets':
      return free(model.data.budgets.filter((b) => b.active === 1)).map((b) => ({ id: b.id, name: b.name, icon: b.icon }));
    case 'events': {
      // the ones still to come or without a date (#504): an event over before this period is no plan's business
      const period = model.periodOf(plan);
      return free(model.data.events.filter((e) => e.archived !== 1 && !isEventPast(e, period))).map((e) => ({ id: e.id, name: e.name, icon: e.icon, color: e.color }));
    }
    case 'goals':
      return free(model.data.goals.filter((g) => g.archived !== 1)).map((g) => ({ id: g.id, name: g.name, icon: g.icon, color: g.color }));
    default:
      return [];
  }
}

/** a budget whose categories a subject of the plan already holds (#535): blocked, with who holds what */
export function budgetOverlaps(model: PlanningModel, plan: PlanRow, budgetId: string): Overlap[] {
  const budget = model.data.budgets.find((b) => b.id === budgetId);
  if (!budget) return [];
  return overlapsOf('', budgetFamily(budget.catIds, model.data.catalog), model.reservationsOf(plan));
}

/** why a candidate is blocked, and the one tap that frees it right here (user 2026-10-21: no going back and forth) */
function BlockedNote({ overlap, model, ops }: Readonly<{ overlap: Overlap; model: PlanningModel; ops: PlanningOps }>) {
  const { t } = useLang();
  const { holder } = overlap;
  const names = overlap.catIds.map((id) => catName(model.data.catalog.byId(id), t)).join(', ');
  return (
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-warning" data-testid={`plan-add-source-blocked-${holder.subjectId}`}>
      <span>{t('plan.overlapNote', { name: holder.name, cats: names })}</span>
      <button
        type="button"
        data-testid={`plan-add-source-free-${holder.subjectId}`}
        onClick={() => void (holder.segment === 'expenses' ? ops.freeCategories(holder.subjectId, overlap.catIds) : ops.removeSubject(holder.subjectId))}
        className="m-tap border-none bg-transparent p-0 font-semibold text-accent-deep"
      >
        {holder.segment === 'expenses' ? t('plan.overlapTake', { name: holder.name }) : t('plan.overlapRemove', { name: holder.name })}
      </button>
    </span>
  );
}

/**
 * Add budgets, recurring costs, loans or goals to the plan — each mirrors its
 * source row. Several at once (user 2026-10-07): a tap ticks a row, the header
 * row ticks them all, one button adds the pick.
 */
export function AddSourceSheet({
  segment,
  model,
  plan,
  ops,
  onClose,
}: Readonly<{ segment: Exclude<PlanSegmentKind, 'expenses'> | null; model: PlanningModel; plan: PlanRow; ops: PlanningOps; onClose: () => void }>) {
  const { t } = useLang();
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const candidates = useMemo(() => (segment ? mirrorCandidates(model, plan, segment) : []), [model, plan, segment]);
  // first come keeps its place (#535): a budget whose categories the plan already counts elsewhere cannot be added until freed
  const blocked = useMemo(
    () => new Map(segment === 'budgets' ? candidates.map((c) => [c.id, budgetOverlaps(model, plan, c.id)] as const).filter(([, o]) => o.length > 0) : []),
    [candidates, model, plan, segment],
  );
  const open = candidates.filter((c) => !blocked.has(c.id));
  // the pick is the segment's (user ss 2026-10-07: "4 of 1" — four recurring costs ticked earlier counted on the goals sheet)
  useEffect(() => setPicked(new Set()), [segment]);
  const pickedHere = open.filter((c) => picked.has(c.id)).length;
  if (!segment) return null;
  const meta = SEGMENT_META[segment];
  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const add = async () => {
    const sources = open.filter((c) => picked.has(c.id));
    if (sources.length === 0 || busy) return;
    setBusy(true);
    try {
      for (const source of sources) await ops.addMirrored(plan.id, segment, source);
      onClose();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={t(meta.addKey)}
      size="tall"
      footer={
        <Button className="w-full" data-testid="plan-add-source-save" disabled={pickedHere === 0 || busy} onClick={() => void add()}>
          {t('plan.addSourceCount', { n: pickedHere })}
        </Button>
      }
    >
      <div data-testid="plan-add-source">
        {candidates.length === 0 && <p className="px-4 py-4 text-center text-[13px] text-ink-4">{t('plan.addSourceNone')}</p>}
        {open.length > 0 && (
          <SelectAllRow
            total={open.length}
            selected={pickedHere}
            testId="plan-add-source-all"
            onChange={(all) => setPicked(all ? new Set(open.map((c) => c.id)) : new Set())}
          />
        )}
        <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
          {candidates.map((source) => {
            const overlaps = blocked.get(source.id);
            if (overlaps) {
              return (
                <div key={source.id} data-testid={`plan-add-source-${source.id}`} aria-disabled className="flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 border-line bg-bg-2 text-ink-4">
                    <Icon name="lock-outline" size={12} />
                  </span>
                  <SourceTile segment={segment} sourceId={source.id} icon={source.icon} color={source.color} model={model} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14px] text-ink-3">{source.name}</span>
                    {overlaps.map((overlap) => (
                      <BlockedNote key={overlap.holder.subjectId} overlap={overlap} model={model} ops={ops} />
                    ))}
                  </span>
                </div>
              );
            }
            const on = picked.has(source.id);
            return (
              <button
                type="button"
                key={source.id}
                data-testid={`plan-add-source-${source.id}`}
                aria-pressed={on}
                onClick={() => toggle(source.id)}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
              >
                <span
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${on ? 'border-accent bg-accent text-white' : 'border-line bg-surface'}`}
                >
                  {on && <Icon name="check" size={12} />}
                </span>
                {/* the source's own face (user 2026-10-09): a recurring cost's logo, a loan's logo, the plan's tile otherwise */}
                <SourceTile segment={segment} sourceId={source.id} icon={source.icon} color={source.color} model={model} testId={`plan-add-source-logo-${source.id}`} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{source.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
