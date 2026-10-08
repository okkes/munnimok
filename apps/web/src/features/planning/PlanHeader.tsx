import { useState } from 'react';
import { useLang } from '@/i18n';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import type { PlanRow } from '@/db/types';
import type { PlanningModel } from '@/application/planning';
import { Button } from '@/ui/Button';
import { AheadCircle } from './AheadCircle';

/**
 * The plan's head: what is left to give a job (green at zero, amber while
 * money idles, red when more was given than the pool holds), the one-tap
 * fill and take-back, and the circle of periods funded ahead. The small
 * line under the number says what it is made of (user 2026-10-08): what
 * the period started with — the balances plus what already left — once
 * anything was spent, the plain pool before that.
 */
export function PlanHeader({
  model,
  plan,
  editable,
  fmt,
  currency,
  onFillAll,
  onWithdrawAll,
  onAhead,
}: Readonly<{
  model: PlanningModel;
  plan: PlanRow;
  editable: boolean;
  fmt: (cents: number, currency: string) => string;
  currency: string;
  onFillAll: () => void;
  onWithdrawAll: () => void;
  onAhead: () => void;
}>) {
  const { t } = useLang();
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const left = model.toAllocateOf(plan);
  let color = 'var(--m-warning)';
  let line = t('plan.toAllocate');
  if (left === 0) {
    color = 'var(--m-accent-deep)';
    line = t('plan.allGiven');
  } else if (left < 0) {
    color = 'var(--m-negative)';
    line = t('plan.overGiven');
  }
  const hasFunding = model.subjectsOf(plan).some((s) => s.fundedCents > 0);
  const started = model.startedWithOf(plan);
  const spent = started - model.poolCents;
  const poolLine =
    spent > 0
      ? t('plan.startedLine', { started: fmt(started, currency), pool: fmt(model.poolCents, currency), spent: fmt(spent, currency) })
      : t('plan.poolLine', { amount: fmt(model.poolCents, currency) });
  return (
    <div className="flex items-center gap-4 rounded-card border border-line bg-surface p-4" data-testid="plan-header">
      <div className="min-w-0 flex-1">
        <div className="m-num text-[28px] leading-tight font-semibold" style={{ color }} data-testid="plan-toallocate">
          {fmt(left, currency)}
        </div>
        <div className="text-[12px] text-ink-3">{line}</div>
        <div className="mt-1 text-[11px] text-ink-4" data-testid="plan-pool-line">
          {poolLine}
        </div>
        {editable && (
          <div className="mt-3 flex flex-wrap gap-2">
            {left > 0 && (
              <Button size="sm" data-testid="plan-fill-all" onClick={onFillAll}>
                {t('plan.fillAll')}
              </Button>
            )}
            {hasFunding && (
              <Button size="sm" variant="outline" data-testid="plan-withdraw-all" onClick={() => setConfirmWithdraw(true)}>
                {t('plan.withdrawAll')}
              </Button>
            )}
          </div>
        )}
      </div>
      {plan.kind === 'actual' && (
        <AheadCircle count={model.aheadCount} suggested={model.aheadSuggested} label={t('plan.ahead')} testId="plan-ahead" onClick={onAhead} />
      )}
      {/* every subject back to zero is a big move: it asks first, with no countdown (user ruling 2026-10-02) */}
      <DangerConfirmSheet
        open={confirmWithdraw}
        onOpenChange={setConfirmWithdraw}
        title={t('plan.withdrawAllTitle')}
        body={t('plan.withdrawAllBody')}
        confirmLabel={t('plan.withdrawAll')}
        cooldown={0}
        testId="plan-withdraw-confirm"
        onConfirm={() => {
          setConfirmWithdraw(false);
          onWithdrawAll();
        }}
      />
    </div>
  );
}
