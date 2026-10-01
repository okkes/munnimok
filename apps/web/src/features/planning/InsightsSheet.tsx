import { useMemo } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { PlanningModel } from '@/application/planning';
import { MultiLine } from '@/ui/charts/MultiLine';
import { Sheet } from '@/ui/Sheet';
import type { MoneyFmt } from './SegmentSection';

/**
 * Insights (#128): set aside against spent, one point per planned
 * period, the current one last — the lines tell whether the plan runs
 * ahead of the spending or chases it.
 */
export function InsightsSheet({
  open,
  onOpenChange,
  model,
  fmt,
  currency,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; model: PlanningModel; fmt: MoneyFmt; currency: string }>) {
  const { t, lang } = useLang();
  const points = useMemo(() => {
    const plans = [...model.pastPlans].reverse();
    if (model.plan) plans.push(model.plan);
    return plans.map((plan) => {
      const views = model.viewsOf(plan);
      return {
        label: new Date(plan.periodStart!).toLocaleDateString(LOCALES[lang], { month: 'short' }),
        setAside: views.reduce((sum, v) => sum + v.fundedCents, 0),
        spent: views.reduce((sum, v) => sum + v.realizedCents, 0),
      };
    });
  }, [model, lang]);
  const last = points.at(-1);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('plan.insights.title')} size="form">
      <div data-testid="plan-insights">
        <p className="mb-2 text-[12px] text-ink-3">{t('plan.insights.hint')}</p>
        {points.length < 2 ? (
          <p className="py-6 text-center text-[13px] text-ink-4" data-testid="plan-insights-none">
            {t('plan.insights.none')}
          </p>
        ) : (
          <>
            <MultiLine
              testId="plan-insights-chart"
              series={[
                { values: points.map((p) => p.setAside / 100), color: 'var(--m-accent)' },
                { values: points.map((p) => p.spent / 100), color: 'var(--m-ink-3)', dashed: true },
              ]}
              labels={points.map((p) => p.label)}
              height={150}
            />
            <div className="mt-2 flex justify-center gap-4 text-[11px] text-ink-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-[2px] w-[14px] rounded" style={{ background: 'var(--m-accent)' }} />
                {t('plan.insights.setAside')}
                {last && <span className="m-num text-ink">{fmt(last.setAside, currency)}</span>}
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-[2px] w-[14px] rounded" style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--m-ink-3) 0 4px, transparent 4px 7px)' }} />
                {t('plan.insights.spent')}
                {last && <span className="m-num text-ink">{fmt(last.spent, currency)}</span>}
              </span>
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
