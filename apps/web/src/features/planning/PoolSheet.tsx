import { useEffect, useState } from 'react';
import { useLang } from '@/i18n';
import type { PlanningModel, PlanningOps } from '@/application/planning';
import { POOL_TYPES } from '@/domain/planning';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import type { MoneyFmt } from './SegmentSection';

const POOL_CANDIDATE_TYPES = new Set(['checking', 'cash', 'savings']);

/**
 * The money pool (#128): the accounts whose balances the plan hands out.
 * Every checking and cash account until the space ticks its own set — a
 * space fact, synced (planPoolAccountIds).
 */
export function PoolSheet({
  open,
  onOpenChange,
  model,
  ops,
  fmt,
  currency,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; model: PlanningModel; ops: PlanningOps; fmt: MoneyFmt; currency: string }>) {
  const { t } = useLang();
  const candidates = model.data.accounts.filter((a) => a.deleted === 0 && a.archived !== 1 && POOL_CANDIDATE_TYPES.has(a.type));
  const defaults = new Set(candidates.filter((a) => POOL_TYPES.has(a.type) && !a.defaultFor).map((a) => a.id));
  const picked = new Set(model.poolAccounts.map((a) => a.id));
  const [ticks, setTicks] = useState<ReadonlySet<string>>(picked);
  const pickedKey = [...picked].sort((a, b) => a.localeCompare(b)).join(',');
  useEffect(() => {
    if (open) setTicks(new Set(pickedKey ? pickedKey.split(',') : []));
  }, [open, pickedKey]);
  const toggle = (id: string) =>
    setTicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const sameAsDefault = ticks.size === defaults.size && [...ticks].every((id) => defaults.has(id));
  const total = candidates.filter((a) => ticks.has(a.id)).reduce((sum, a) => sum + a.balanceCents, 0);
  const save = async () => {
    await ops.setPoolAccounts(sameAsDefault ? null : [...ticks]);
    onOpenChange(false);
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('plan.poolTitle')}
      size="tall"
      footer={
        <Button className="w-full" data-testid="plan-pool-save" onClick={() => void save()}>
          {t('action.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="plan-pool">
        <p className="text-[12px] text-ink-3">{t('plan.poolHint')}</p>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {candidates.map((account) => {
            const on = ticks.has(account.id);
            return (
              <button
                key={account.id}
                data-testid={`plan-pool-${account.id}`}
                aria-pressed={on}
                onClick={() => toggle(account.id)}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
              >
                <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${on ? 'border-accent bg-accent' : 'border-line bg-transparent'}`}>
                  {on && <Icon name="check" size={14} color="white" />}
                </span>
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{account.name}</span>
                <span className="m-num text-[13px] text-ink-2">{fmt(account.balanceCents, account.currency ?? currency)}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-baseline justify-between px-1 text-[13px]">
          <span className="text-ink-3">{sameAsDefault ? t('plan.poolAll') : t('plan.poolPicked', { n: ticks.size })}</span>
          <span className="m-num font-semibold text-ink" data-testid="plan-pool-total">
            {fmt(total, currency)}
          </span>
        </div>
      </div>
    </Sheet>
  );
}
