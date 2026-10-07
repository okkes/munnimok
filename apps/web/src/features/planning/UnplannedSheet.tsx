import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import type { UnplannedMain } from '@/domain/planning';
import { catName, useCategories } from '@/features/categories/useCategories';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { AmountSuggestions } from './AmountSuggestions';
import type { OverBudgetGuard } from './overBudget';
import type { MoneyFmt } from './SegmentSection';

/**
 * An unplanned main opened (user 2026-10-07): what it spent, by sub, and
 * the money to set aside for it — funding makes it an expense subject
 * without a target, born funded by what was already spent; Plan it (the
 * editor, with a target) moved here from the list.
 */
export function UnplannedSheet({
  row,
  left,
  guard,
  fmt,
  currency,
  onFund,
  onPlan,
  onClose,
}: Readonly<{
  row: UnplannedMain | null;
  /** what the pool still has to give */
  left: number;
  guard: OverBudgetGuard;
  fmt: MoneyFmt;
  currency: string;
  onFund: (row: UnplannedMain, cents: number) => Promise<void>;
  onPlan: (row: UnplannedMain) => void;
  onClose: () => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const spent = row?.cents ?? 0;
  useEffect(() => {
    setDraft((spent / 100).toFixed(2));
  }, [row?.mainId, spent]);
  if (!row) return null;
  const main = cats.byId(row.mainId);
  const subs = row.subs.filter((s) => s.catId !== row.mainId);
  const typed = parseCents(draft);
  const fund = () => {
    if (typed === null || typed < 0 || busy) return;
    // only the part above what was already spent is the pool's to give
    guard.guard(left, typed - spent, () => {
      setBusy(true);
      void onFund(row, typed).finally(() => setBusy(false));
    });
  };
  return (
    <Sheet open onOpenChange={(next) => !next && onClose()} title={catName(main, t)} size="tall">
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
        <p className="px-1 text-[11px] text-ink-4">{t('plan.unplannedFundHint')}</p>
        <div className="m-cap px-1">{t('plan.fund.amount', { currency })}</div>
        <input
          data-testid="plan-unplanned-input"
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none"
        />
        <AmountSuggestions
          items={[{ id: 'spent', label: t('plan.fund.chipSpent'), cents: row.cents }]}
          fmt={fmt}
          currency={currency}
          testIdPrefix="plan-unplanned-chip"
          onPick={(cents) => setDraft((cents / 100).toFixed(2))}
        />
        <Button className="w-full" data-testid="plan-unplanned-fund" disabled={typed === null || typed < 0 || busy} onClick={fund}>
          {t('plan.unplannedFund')}
        </Button>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <Row icon="pencil-outline" title={t('plan.unplannedPlan')} sub={t('plan.unplannedPlanSub')} testId="plan-unplanned-plan" onClick={() => onPlan(row)} />
        </div>
        <p className="flex items-start gap-2 text-[11px] text-ink-4">
          <Icon name="information-outline" size={14} />
          <span>{t('plan.unplannedHint')}</span>
        </p>
      </div>
    </Sheet>
  );
}
