import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLang } from '@/i18n';
import type { PlanRow, PlanSegmentKind, PlanSubjectRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { Button } from '@/ui/Button';
import { useDragReorder } from '@/ui/dragReorder';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { SEGMENT_COLOR, SEGMENT_META } from './planningUi';

/** the drag list: the pressed row hides, a ghost follows the finger, the move commits on release */
function SubjectList({ rows, onMove }: Readonly<{ rows: PlanSubjectRow[]; onMove: (from: number, to: number) => void }>) {
  const { t } = useLang();
  const { drag, ghostRect, setRowRef, setGhostRef, rowStyle, handleProps } = useDragReorder(rows.length, onMove);
  const face = (row: PlanSubjectRow) => <Icon name={row.icon ?? SEGMENT_META[row.segment].icon} size={19} color={row.color ?? SEGMENT_COLOR[row.segment]} />;
  return (
    <>
      {rows.map((row, index) => (
        <div key={row.id} ref={setRowRef(index)} data-testid={`plan-reorder-row-${row.id}`} style={rowStyle(index)} className="flex items-center gap-2.5 border-b border-line-2 py-2 last:border-0">
          {face(row)}
          <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{row.name}</span>
          <button
            aria-label={t('home.dragHandle')}
            data-testid={`plan-reorder-drag-${row.id}`}
            {...handleProps(index)}
            className="m-tap flex h-9 w-9 shrink-0 cursor-grab touch-none items-center justify-center border-none bg-transparent text-ink-4 select-none"
          >
            <Icon name="drag-horizontal-variant" size={18} />
          </button>
        </div>
      ))}
      {drag &&
        ghostRect &&
        createPortal(
          <div
            ref={setGhostRef}
            data-testid="plan-reorder-ghost"
            className="pointer-events-none fixed z-50 flex items-center gap-2.5 rounded-input border border-accent bg-surface px-3 shadow-2xl"
            style={{ left: ghostRect.left, width: ghostRect.width, height: ghostRect.height }}
          >
            {face(rows[drag.from])}
            <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">{rows[drag.from].name}</span>
            <Icon name="drag-horizontal-variant" size={18} color="var(--m-ink-4)" />
          </div>,
          document.body,
        )}
    </>
  );
}

/** the subjects of one segment in the order the plan lists (and fills) them */
export function ReorderSheet({
  segment,
  model,
  plan,
  ops,
  onClose,
}: Readonly<{ segment: PlanSegmentKind | null; model: PlanningModel; plan: PlanRow; ops: PlanningOps; onClose: () => void }>) {
  const { t } = useLang();
  const [rows, setRows] = useState<PlanSubjectRow[]>([]);
  useEffect(() => {
    if (segment) setRows(model.subjectsOf(plan).filter((s) => s.segment === segment));
  }, [segment, model, plan]);
  if (!segment) return null;
  const save = async () => {
    await ops.reorderSubjects(rows.map((r) => r.id));
    onClose();
  };
  return (
    <Sheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('plan.reorder.title', { segment: t(SEGMENT_META[segment].labelKey) })}
      size="tall"
      footer={
        <Button className="w-full" data-testid="plan-reorder-save" onClick={() => void save()}>
          {t('action.save')}
        </Button>
      }
    >
      <p className="mb-2 text-[12px] text-ink-3">{t('plan.reorder.hint')}</p>
      <div data-testid="plan-reorder">
        <SubjectList
          rows={rows}
          onMove={(from, to) =>
            setRows((prev) => {
              const next = [...prev];
              const [moved] = next.splice(from, 1);
              next.splice(to, 0, moved);
              return next;
            })
          }
        />
      </div>
    </Sheet>
  );
}
