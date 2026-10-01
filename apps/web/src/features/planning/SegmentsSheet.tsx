import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanRow, PlanSegmentConfig } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { BlockListEditor } from '@/features/customize/BlockListEditor';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { SEGMENT_META } from './planningUi';

/**
 * The segments (#128): their order in the plan and whether they take
 * part — a segment switched off leaves with its subjects (their money
 * returns to the pool). Saved on the plan; blueprints carry it too.
 */
export function SegmentsSheet({
  open,
  onOpenChange,
  model,
  plan,
  ops,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; model: PlanningModel; plan: PlanRow; ops: PlanningOps }>) {
  const { t } = useLang();
  const [rows, setRows] = useState<PlanSegmentConfig[]>(() => model.segmentsOf(plan));
  useEffect(() => {
    if (open) setRows(model.segmentsOf(plan));
  }, [open, model, plan]);
  const save = async () => {
    await ops.setSegments(plan, rows);
    onOpenChange(false);
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('plan.segmentsTitle')}
      size="form"
      footer={
        <Button className="w-full" data-testid="plan-segments-save" onClick={() => void save()}>
          {t('action.save')}
        </Button>
      }
    >
      <p className="mb-2 text-[12px] text-ink-3">{t('plan.segmentsHint')}</p>
      <div data-testid="plan-segments">
        <BlockListEditor
          rows={rows.map((s) => ({ id: s.kind, label: t(SEGMENT_META[s.kind].labelKey), icon: SEGMENT_META[s.kind].icon, hidden: s.hidden === 1 }))}
          testPrefix="plan-segments"
          onToggle={(index) => setRows((prev) => prev.map((s, i) => (i === index ? { ...s, hidden: s.hidden === 1 ? 0 : 1 } : s)))}
          onReorder={(from, to) =>
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
