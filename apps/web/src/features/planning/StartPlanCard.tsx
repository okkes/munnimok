import { useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanStart, PlanningModel, PlanningOps } from '@/application/planning';
import { catName, useCategories } from '@/features/categories/useCategories';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Row } from '@/ui/primitives';
import { periodLabel } from './AheadSheet';

/**
 * No plan for the period yet (#128): start it like the last one, from a
 * blueprint, from munni's suggestion (the recurring costs and loans, the
 * budgets and goals, and the mains you spend on — sized from the history
 * or from the income you type) or empty.
 */
export function StartPlanCard({ model, ops, currency }: Readonly<{ model: PlanningModel; ops: PlanningOps; currency: string }>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const [income, setIncome] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async (from: PlanStart) => {
    if (busy) return;
    setBusy(true);
    try {
      await ops.startPlan(model.period, from);
    } finally {
      setBusy(false);
    }
  };
  const recommend = () =>
    start({ kind: 'recommendation', nameOf: (catId) => catName(cats.byId(catId), t), incomeCents: income.trim() ? parseCents(income) : null });
  return (
    <div className="rounded-card border border-line bg-surface p-4" data-testid="plan-start">
      <div className="flex items-start gap-3">
        <Icon name="clipboard-text-outline" size={22} color="var(--m-accent-deep)" />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium text-ink">{t('plan.start.title', { period: periodLabel(model.period, lang) })}</div>
          <p className="mt-0.5 text-[12px] text-ink-3">{t('plan.start.body')}</p>
        </div>
      </div>
      <div className="mt-3 overflow-hidden rounded-card border border-line">
        {model.pastPlans.length > 0 && <Row icon="history" title={t('plan.start.last')} testId="plan-start-last" onClick={() => void start({ kind: 'last' })} />}
        {model.blueprints.map((blueprint) => (
          <Row
            key={blueprint.id}
            icon="content-copy"
            title={t('plan.start.blueprint', { name: blueprint.name ?? '' })}
            testId={`plan-start-blueprint-${blueprint.id}`}
            onClick={() => void start({ kind: 'blueprint', id: blueprint.id })}
          />
        ))}
        <Row icon="auto-fix" title={t('plan.start.recommend')} sub={t('plan.start.recommendSub')} testId="plan-start-recommend" onClick={() => void recommend()} />
        <Row icon="plus" title={t('plan.start.empty')} testId="plan-start-empty" onClick={() => void start({ kind: 'empty' })} />
      </div>
      <div className="mt-3">
        <div className="m-cap px-1">{t('plan.start.income', { currency })}</div>
        <input
          data-testid="plan-start-income"
          inputMode="decimal"
          value={income}
          onChange={(e) => setIncome(e.target.value)}
          placeholder="0.00"
          className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
        <p className="mt-1 px-1 text-[11px] text-ink-4">{t('plan.start.incomeHint')}</p>
      </div>
      {busy && (
        <Button size="sm" variant="ghost" disabled className="mt-2">
          …
        </Button>
      )}
    </div>
  );
}
