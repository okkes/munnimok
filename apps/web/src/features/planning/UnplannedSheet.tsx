import { useLang } from '@/i18n';
import type { UnplannedMain } from '@/domain/planning';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Icon } from '@/ui/Icon';
import { Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import type { MoneyFmt } from './SegmentSection';

/**
 * An unplanned main opened: what it spent, by sub, and the one door — Plan
 * it (the editor, filled in with the spending as the target). The "Set
 * aside" amount it used to carry is gone (user 2026-10-08: "I just don't
 * know what it will do"): what was spent here already counts in the pool,
 * so the person plans the subject and then funds it to cover the spending.
 */
export function UnplannedSheet({
  row,
  fmt,
  currency,
  onPlan,
  onClose,
}: Readonly<{
  row: UnplannedMain | null;
  fmt: MoneyFmt;
  currency: string;
  onPlan: (row: UnplannedMain) => void;
  onClose: () => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  if (!row) return null;
  const main = cats.byId(row.mainId);
  const subs = row.subs.filter((s) => s.catId !== row.mainId);
  return (
    <Sheet open onOpenChange={(next) => !next && onClose()} title={catName(main, t)} size="form">
      <div className="flex flex-col gap-3" data-testid="plan-unplanned-sheet">
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
          <Row icon="pencil-outline" title={t('plan.unplannedPlan')} sub={t('plan.unplannedPlanSub')} testId="plan-unplanned-plan" onClick={() => onPlan(row)} />
        </div>
        <p className="flex items-start gap-2 text-[11px] text-ink-4" data-testid="plan-unplanned-sheet-hint">
          <Icon name="information-outline" size={14} />
          <span>{t('plan.unplannedPlanHint')}</span>
        </p>
      </div>
    </Sheet>
  );
}
