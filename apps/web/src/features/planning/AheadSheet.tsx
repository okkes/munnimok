import { LOCALES, useLang } from '@/i18n';
import type { PlanRow } from '@/db/types';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { sameSubjects } from '@/domain/planning';
import type { Period } from '@/domain/periods';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { ProgressBar } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { AheadCircle } from './AheadCircle';
import type { MoneyFmt } from './SegmentSection';

export const periodLabel = (period: Period, lang: keyof typeof LOCALES): string => {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  return `${fmt(period.start)} – ${fmt(period.end)}`;
};

const PERIOD_KEY = { week: 'plan.rhythm.week', biweekly: 'plan.rhythm.biweekly', month: 'plan.rhythm.month' } as const;

/** do the periods ahead still mirror the current plan's shape? */
export const aheadDiffers = (model: PlanningModel, plan: PlanRow): boolean =>
  model.ahead.some((a) => !sameSubjects(model.subjectsOf(a.plan), model.subjectsOf(plan)));

/**
 * The periods ahead (#128): money set aside for the periods to come,
 * filled in the plan's order from what is left — fund the next one, take
 * one back, and push the current plan's shape into all of them.
 */
export function AheadSheet({
  open,
  onOpenChange,
  model,
  plan,
  ops,
  fmt,
  currency,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; model: PlanningModel; plan: PlanRow; ops: PlanningOps; fmt: MoneyFmt; currency: string }>) {
  const { t, lang } = useLang();
  const left = model.toAllocateOf(plan);
  const rhythm = model.data.space?.periodType ?? 'month';
  const rhythmKey = PERIOD_KEY[rhythm as keyof typeof PERIOD_KEY] ?? 'plan.rhythm.month';
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('plan.aheadTitle')} size="tall">
      <div className="flex flex-col gap-3" data-testid="plan-ahead-sheet">
        <div className="flex items-center gap-4">
          <AheadCircle count={model.aheadCount} suggested={model.aheadSuggested} label={t('plan.ahead')} testId="plan-ahead-sheet-circle" />
          <p className="min-w-0 flex-1 text-[12px] text-ink-3">{t('plan.aheadHint', { m: model.aheadSuggested, period: t(rhythmKey) })}</p>
        </div>
        <Button data-testid="plan-ahead-fund" disabled={left <= 0} onClick={() => void ops.fundAhead(model.nextAheadPeriod)}>
          {t('plan.fundNext', { period: periodLabel(model.nextAheadPeriod, lang) })}
        </Button>
        {left <= 0 && <p className="-mt-1 px-1 text-[11px] text-ink-4">{t('plan.aheadNothingLeft')}</p>}
        {model.ahead.length === 0 ? (
          <p className="py-3 text-center text-[13px] text-ink-4" data-testid="plan-ahead-none">
            {t('plan.aheadNone')}
          </p>
        ) : (
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            {model.ahead.map((ahead) => (
              <div key={ahead.plan.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0" data-testid={`plan-ahead-row-${ahead.period.start}`}>
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between text-[13px]">
                    <span className="font-medium text-ink">{periodLabel(ahead.period, lang)}</span>
                    <span className="m-num text-ink-2">{fmt(ahead.fundedCents, currency)}</span>
                  </span>
                  <ProgressBar value={ahead.fraction} size="sm" className="mt-1.5" />
                  <span className="mt-1 block text-[11px] text-ink-4">{t('plan.aheadFunded', { pct: Math.round(ahead.fraction * 100) })}</span>
                </span>
                {ahead.fundedCents > 0 && (
                  <button
                    data-testid={`plan-ahead-withdraw-${ahead.period.start}`}
                    aria-label={t('plan.withdrawAhead')}
                    onClick={() => void ops.withdrawAhead(ahead.plan)}
                    className="m-tap flex h-9 w-9 items-center justify-center rounded-full border-none bg-transparent text-ink-3"
                  >
                    <Icon name="undo-variant" size={18} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
        {aheadDiffers(model, plan) && (
          <div className="rounded-card bg-bg-2 px-3 py-3" data-testid="plan-ahead-differs">
            <p className="text-[12px] text-ink-2">{t('plan.applyAheadHint')}</p>
            <Button size="sm" variant="outline" className="mt-2" data-testid="plan-ahead-apply" onClick={() => void ops.applyToAhead(plan)}>
              {t('plan.applyAhead')}
            </Button>
          </div>
        )}
      </div>
    </Sheet>
  );
}
