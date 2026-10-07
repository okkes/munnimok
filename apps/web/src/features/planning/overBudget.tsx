import { useState } from 'react';
import { useLang } from '@/i18n';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import type { MoneyFmt } from './SegmentSection';

/**
 * Funding past what the pool holds asks once (user 2026-10-07): the first
 * time a day it is pointed out and confirmed, after that the day's funding
 * goes through without a word — the mark is per space, on this device.
 */
const key = (spaceId: string) => `munni_plan_overbudget_${spaceId}`;

export const todayKey = (): string => new Date().toISOString().slice(0, 10);

export function ackedToday(spaceId: string): boolean {
  try {
    return localStorage.getItem(key(spaceId)) === todayKey();
  } catch {
    return false;
  }
}

export function ackToday(spaceId: string): void {
  try {
    localStorage.setItem(key(spaceId), todayKey());
  } catch {
    // storage blocked: it asks again next time
  }
}

/** true when giving deltaCents more would take what is left of the pool below zero */
export const exceedsPool = (leftCents: number, deltaCents: number): boolean => deltaCents > 0 && leftCents - deltaCents < 0;

export interface OverBudgetGuard {
  /** runs `run` at once, or after the person confirms going beyond the pool */
  guard: (leftCents: number, deltaCents: number, run: () => void) => void;
  pending: { overCents: number; run: () => void } | null;
  confirm: () => void;
  dismiss: () => void;
}

export function useOverBudgetGuard(spaceId: string): OverBudgetGuard {
  const [pending, setPending] = useState<OverBudgetGuard['pending']>(null);
  const guard = (leftCents: number, deltaCents: number, run: () => void) => {
    if (!exceedsPool(leftCents, deltaCents) || ackedToday(spaceId)) {
      run();
      return;
    }
    setPending({ overCents: deltaCents - Math.max(0, leftCents), run });
  };
  const confirm = () => {
    if (!pending) return;
    ackToday(spaceId);
    const { run } = pending;
    setPending(null);
    run();
  };
  return { guard, pending, confirm, dismiss: () => setPending(null) };
}

/** the question itself, mounted once per screen that funds */
export function OverBudgetSheet({ guard, fmt, currency }: Readonly<{ guard: OverBudgetGuard; fmt: MoneyFmt; currency: string }>) {
  const { t } = useLang();
  return (
    <DangerConfirmSheet
      open={guard.pending !== null}
      onOpenChange={(open) => !open && guard.dismiss()}
      title={t('plan.overBudgetTitle')}
      body={t('plan.overBudgetBody', { amount: fmt(guard.pending?.overCents ?? 0, currency) })}
      confirmLabel={t('plan.overBudgetConfirm')}
      cooldown={0}
      testId="plan-overbudget"
      onConfirm={guard.confirm}
    />
  );
}
