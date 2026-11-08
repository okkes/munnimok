import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useQuery } from '@/db/useQuery';
import { useGoalOps, useGoals } from '@/application/goals';
import { localToday } from '@/application/recurring';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { cashOutCandidates } from '@/domain/goals';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';

/**
 * #455 (user): "once the user achieved its goal … cash out and select the
 * transaction(s)". A full screen like attaching to an event: the money
 * that left the savings pool lines up, newest first, nothing ticked — the
 * person names what paid for the goal. Cashing out archives the goal; the
 * picked rows stay in the history but leave the saving of their period,
 * and what the goal held beyond them is back in the savings pool.
 */
export function GoalCashOutScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const { goalId } = useParams({ strict: false }) as { goalId: string };
  const goals = useGoals();
  const accounts = useSpaceAccounts();
  const txs = useSpaceTransactions();
  const ops = useGoalOps();
  const canEdit = useCanEdit(); // #505
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);
  const { fmt, fmtSensitive } = useDisplayMoney();

  const goal = goals?.find((g) => g.id === goalId);
  // a goal deleted meanwhile, or already cashed out on another device: nothing to pick here
  useEffect(() => {
    if (!goals) return;
    if (!goal) void navigate({ to: '/goals', replace: true });
    else if (goal.archived === 1) void navigate({ to: '/goals/$goalId', params: { goalId }, replace: true });
  }, [goals, goal, goalId, navigate]);

  const candidates = useMemo(
    () => (txs && accounts && goals ? cashOutCandidates(txs, accounts, space, goals, localToday()) : undefined),
    [txs, accounts, goals, space],
  );
  if (!goal) return <div className="h-full" data-testid="screen-goal-cashout" />;

  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmt(cents, currency);
  // #530: what the goal holds and what goes back hide with the sensitive figures; the picked spending stays
  const balance = (cents: number) => fmtSensitive(cents, currency);
  const selected = (candidates ?? []).filter((tx) => picked.has(tx.id));
  const selectedCents = selected.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  const leftover = goal.allocatedCents - selectedCents;

  const toggle = (id: string) => {
    const next = new Set(picked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };

  const confirm = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await ops.cashOut(goal, selected.map((tx) => tx.id));
      // replace: back from the goal leaves it, not into a finished pick
      void navigate({ to: '/goals/$goalId', params: { goalId: goal.id }, replace: true });
    } finally {
      setBusy(false);
    }
  };

  const figures: [string, string, string][] = [
    ['saved', t('goals.cashOutSaved'), balance(goal.allocatedCents)],
    ['selected', t('goals.cashOutSelected'), money(selectedCents)],
    ['back', t('goals.cashOutBack'), balance(Math.max(0, leftover))],
  ];

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-goal-cashout">
      <AppBar
        title={t('goals.cashOutTitle', { name: goal.name })}
        leading={
          <IconButton label={t('action.back')} testId="goalcashout-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <p className="px-1 pb-3 text-[12px] leading-snug text-ink-3">{t('goals.cashOutIntro', { name: goal.name })}</p>
        <div className="grid grid-cols-3 gap-3 rounded-card border border-line bg-surface p-4" data-testid="goalcashout-summary">
          {figures.map(([id, label, text]) => (
            <div key={id} data-testid={`goalcashout-fig-${id}`}>
              <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{label}</div>
              <div className="m-num mt-0.5 text-[15px] font-semibold text-ink">{text}</div>
            </div>
          ))}
        </div>
        {leftover < 0 && (
          <p className="mt-2 flex items-start gap-1.5 px-1 text-[12px] leading-snug text-warning" data-testid="goalcashout-over">
            <Icon name="information-outline" size={14} />
            {t('goals.cashOutOver', { amount: balance(-leftover) })}
          </p>
        )}
        <div className="m-cap mt-5 mb-1 px-1">{t('goals.cashOutPick')}</div>
        <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1" data-testid="goalcashout-list">
          {(candidates ?? []).map((tx) => {
            const checked = picked.has(tx.id);
            return (
              <div key={tx.id} className="flex items-center gap-2">
                <button
                  data-testid={`goalcashout-pick-${tx.id}`}
                  aria-label={tx.merchant}
                  aria-pressed={checked}
                  onClick={() => toggle(tx.id)}
                  className={`m-tap ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                    checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
                  }`}
                >
                  {checked && <Icon name="check" size={12} />}
                </button>
                <div className="min-w-0 flex-1">
                  <TxRow tx={tx} showDate onClick={() => toggle(tx.id)} />
                </div>
              </div>
            );
          })}
          {candidates?.length === 0 && (
            <p className="px-1 py-4 text-[12px] leading-snug text-ink-4" data-testid="goalcashout-empty">
              {t('goals.cashOutNone')}
            </p>
          )}
        </div>
      </div>
      <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
        <ReadOnlyNote className="mb-2" testId="goalcashout-readonly-note" />
        <Button className="w-full" data-testid="goalcashout-confirm" disabled={busy || selected.length === 0 || !canEdit} onClick={() => void confirm()}>
          {t('goals.cashOutConfirm', { amount: money(selectedCents) })}
        </Button>
      </div>
    </div>
  );
}
