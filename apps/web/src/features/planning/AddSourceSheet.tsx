import { useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanRow, PlanSegmentKind } from '@/db/types';
import type { MirroredSource, PlanningModel, PlanningOps } from '@/application/planning';
import { isDebtTracked } from '@/domain/debts';
import { Icon } from '@/ui/Icon';
import { Button } from '@/ui/Button';
import { Tile } from '@/ui/primitives';
import { SelectAllRow } from '@/ui/SelectAllRow';
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
    const sources = candidates.filter((c) => picked.has(c.id));
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
        <Button className="w-full" data-testid="plan-add-source-save" disabled={picked.size === 0 || busy} onClick={() => void add()}>
          {t('plan.addSourceCount', { n: picked.size })}
        </Button>
      }
    >
      <div data-testid="plan-add-source">
        {candidates.length === 0 && <p className="px-4 py-4 text-center text-[13px] text-ink-4">{t('plan.addSourceNone')}</p>}
        {candidates.length > 0 && (
          <SelectAllRow
            total={candidates.length}
            selected={picked.size}
            testId="plan-add-source-all"
            onChange={(all) => setPicked(all ? new Set(candidates.map((c) => c.id)) : new Set())}
          />
        )}
        <div className="mt-2 overflow-hidden rounded-card border border-line bg-surface">
          {candidates.map((source) => {
            const color = source.color ?? SEGMENT_COLOR[segment];
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
                <Tile icon={source.icon ?? meta.icon} bg={softOf(color)} color={color} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{source.name}</span>
              </button>
            );
          })}
        </div>
      </div>
    </Sheet>
  );
}
