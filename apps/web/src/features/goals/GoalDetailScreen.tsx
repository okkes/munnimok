import { useEffect, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang, TFunc } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useGoalOps, useGoals } from '@/application/goals';
import { parseLocalDate } from '@/application/planningModel';
import { localToday } from '@/application/recurring';
import { goalOverview, goalProgress, paceCentsPerPeriod, periodUnitKey, periodsLeft } from '@/domain/goals';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { GoalRow, SpaceRow } from '@/db/types';
import { parseCents } from '@/lib/money';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { FormBlockerNote, blockerRing } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { HeroCard, ProgressBar, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';
import { GoalFormSheet } from './GoalsScreen';

/** the line under the bar: when the goal was cashed out, that it is reached, or the pace that reaches it by its date; null without a date to pace for */
function paceLineOf(
  goal: GoalRow,
  state: { reached: boolean; pace: number | null; periods: number | null; periodType: SpaceRow['periodType'] | undefined },
  format: { t: TFunc; lang: Lang; money: (cents: number) => string; date: (iso: string) => string },
): string | null {
  const { t } = format;
  if (goal.cashOut) return t('goals.cashedOutOn', { date: format.date(goal.cashOut.date) });
  if (state.reached) return t('goals.reached');
  if (state.pace === null || state.periods === null || !goal.targetDate) return null;
  const unit = t(periodUnitKey(state.periodType));
  const date = new Date(goal.targetDate).toLocaleDateString(LOCALES[format.lang], { month: 'short', year: 'numeric' });
  return state.periods > 1
    ? t('goals.paceLong', { amount: format.money(state.pace), unit, n: state.periods, date })
    : t('goals.paceLongOnce', { amount: format.money(state.pace), unit, date });
}

/** One goal: progress, pace, and the funding audit trail. */
export function GoalDetailScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const { goalId } = useParams({ strict: false }) as { goalId: string };
  const goals = useGoals();
  const accounts = useSpaceAccounts();
  const txs = useSpaceTransactions();
  const ops = useGoalOps();
  const canEdit = useCanEdit(); // #505
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const contributions = useQuery(store, 
    async () => {
      const rows = (await store.bySpace('goalContribution', spaceId)).filter((c) => c.deleted === 0 && c.goalId === goalId);
      rows.sort((a, b) => b.date.localeCompare(a.date));
      return rows;
    },
    [spaceId, goalId],
  );
  const [formInitial, setFormInitial] = useState<GoalRow | 'new' | null>(null);
  const [fundOpen, setFundOpen] = useState<'fund' | 'withdraw' | null>(null);
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  // #195: tappable — an invalid tap names the blocker
  const [attempted, setAttempted] = useState(false);

  const goal = goals?.find((g) => g.id === goalId);
  // deleted here or on another device: leave the orphaned detail
  useEffect(() => {
    if (goals && !goal) void navigate({ to: '/goals', replace: true });
  }, [goals, goal, navigate]);
  const { fmt, fmtSensitive, hideSensitive } = useDisplayMoney();
  if (!goal) return <div className="h-full" data-testid="screen-goal-detail" />;

  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmt(cents, currency);
  // #530: what the goal holds, what is still to go and the free savings hide with the sensitive figures
  const balance = (cents: number) => fmtSensitive(cents, currency);
  const progress = goalProgress(goal);
  // the pace counts the space's own periods, and says how many (user 2026-10-04)
  const pace = paceCentsPerPeriod(goal, space, localToday());
  const periods = periodsLeft(space, goal.targetDate, localToday());
  const reached = goal.allocatedCents >= goal.targetCents;

  const fundCents = parseCents(amount);
  const fundBad = fundCents === null || fundCents <= 0;
  // #368 (user): funding draws from the savings pool — never more than is
  // still unallocated; a pool already negative funds nothing until it is
  // back at zero (withdraw from a goal first)
  const available = goalOverview(goals ?? [], accounts ?? [], space).unallocatedCents;
  const fundOverPool = fundOpen === 'fund' && fundCents !== null && fundCents > available;

  const submitFunding = async () => {
    const cents = parseCents(amount);
    if (!fundOpen || cents === null || cents <= 0) return;
    await ops.contribute(goal.id, fundOpen === 'fund' ? cents : -cents, note.trim() || undefined);
    setFundOpen(null);
    setAmount('');
    setNote('');
    setAttempted(false);
  };

  const fmtDate = (iso: string) => parseLocalDate(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

  // #455: what paid for the goal — the rows still visible to the space, the money they took out of savings
  const cashOut = goal.cashOut ?? null;
  const cashedTxs = cashOut ? (txs ?? []).filter((tx) => tx.deleted === 0 && cashOut.txIds.includes(tx.id)) : [];
  const cashedCents = cashedTxs.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  const leftover = goal.allocatedCents - cashedCents;

  // #449 (user): the amount still to add, on the page itself - the bar alone said nothing
  const toGoLine = t('goals.toGo', { amount: balance(goal.targetCents - goal.allocatedCents) });
  const paceLine = paceLineOf(goal, { reached, pace, periods, periodType: space?.periodType }, { t, lang, money, date: fmtDate });

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-goal-detail">
      <AppBar
        title={goal.name}
        leading={
          <IconButton label={t('action.back')} testId="goaldetail-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          canEdit && (
            <IconButton label={t('goals.edit')} testId="goaldetail-edit" onClick={() => setFormInitial(goal)}>
              <Icon name="pencil-outline" size={20} />
            </IconButton>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <ReadOnlyNote className="mb-3" testId="goaldetail-readonly-note" />
        <HeroCard
          testId="goaldetail-hero"
          tile={
            goal.picture ? (
              <img src={goal.picture} alt="" className="h-12 w-12 shrink-0 rounded-2xl object-cover" data-testid="goal-cover" />
            ) : (
              <Tile size={48} icon={goal.icon ?? 'flag-outline'} />
            )
          }
          number={<span data-testid="goaldetail-allocated">{balance(goal.allocatedCents)}</span>}
          sub={t('budgets.of', { amount: money(goal.targetCents) })}
          // beside the visible target the percentage and a filled bar would give the hidden amount away
          right={hideSensitive ? undefined : <span className="m-num shrink-0 text-[14px] font-semibold text-accent-deep">{Math.round(progress * 100)}%</span>}
          progress={<ProgressBar value={hideSensitive ? 0 : progress} />}
          meta={
            <span className="flex flex-col">
              {!reached && <span data-testid="goaldetail-togo">{toGoLine}</span>}
              {paceLine && <span data-testid="goaldetail-pace">{paceLine}</span>}
            </span>
          }
        />

        {cashOut ? (
          // #455: the goal was spent — what paid for it, where the rest went, and the way back
          <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="goaldetail-cashedout">
            <div className="flex items-center gap-2">
              <Icon name="flag-checkered" size={18} color="var(--m-accent-deep)" />
              <span className="text-[14px] font-semibold text-ink">{t('goals.cashedOutTitle')}</span>
            </div>
            <p className="mt-1 text-[13px] leading-snug text-ink-2" data-testid="goaldetail-cashedout-sum">
              {t('goals.cashedOutBody', { amount: money(cashedCents) })}
            </p>
            {leftover !== 0 && (
              <p className="mt-1 text-[12px] leading-snug text-ink-3" data-testid="goaldetail-cashedout-rest">
                {leftover > 0 ? t('goals.cashedOutBack', { amount: balance(leftover) }) : t('goals.cashedOutBeyond', { amount: balance(-leftover) })}
              </p>
            )}
            {cashedTxs.length > 0 && (
              <div className="mt-2 divide-y divide-line-2 border-t border-line-2" data-testid="goaldetail-cashedout-txs">
                {cashedTxs.map((tx) => (
                  <TxRow key={tx.id} tx={tx} showDate onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })} />
                ))}
              </div>
            )}
            {canEdit && (
              <Button variant="outline" className="mt-3 w-full" data-testid="goaldetail-undo-cashout" onClick={() => void ops.undoCashOut(goal)}>
                {t('goals.cashOutUndo')}
              </Button>
            )}
          </div>
        ) : (
          canEdit && (
          <>
            {reached && (
              <div className="mt-3 flex flex-col gap-2 rounded-card bg-accent-soft p-4" data-testid="goaldetail-reached">
                <p className="text-[13px] leading-snug text-ink-2">{t('goals.cashOutHint')}</p>
                <Button
                  data-testid="goaldetail-cashout"
                  onClick={() => void navigate({ to: '/goals/$goalId/cashout', params: { goalId: goal.id } })}
                >
                  {t('goals.cashOut')}
                </Button>
              </div>
            )}
            <div className="mt-3 flex gap-2">
              <Button className="flex-1" data-testid="goaldetail-fund" onClick={() => setFundOpen('fund')}>
                {t('goals.fund')}
              </Button>
              <Button variant="outline" className="flex-1" data-testid="goaldetail-withdraw" onClick={() => setFundOpen('withdraw')}>
                {t('goals.withdraw')}
              </Button>
            </div>
          </>
          )
        )}

        <div className="m-cap mt-5 mb-1 px-1">
          {t('goals.history')} · {contributions?.length ?? 0}
        </div>
        {(contributions?.length ?? 0) > 0 ? (
          <div className="rounded-card border border-line bg-surface px-4 py-1" data-testid="goaldetail-history">
            {contributions!.map((c) => (
              <div key={c.id} className="flex items-center gap-3 border-b border-line-2 py-2.5 last:border-0">
                <Icon
                  name={c.amountCents >= 0 ? 'tray-arrow-down' : 'tray-arrow-up'}
                  size={16}
                  color={c.amountCents >= 0 ? 'var(--m-accent-deep)' : 'var(--m-warning)'}
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-ink">{c.note ?? (c.amountCents >= 0 ? t('goals.fund') : t('goals.withdraw'))}</span>
                  <span className="block text-[11px] text-ink-4">{fmtDate(c.date)}</span>
                </span>
                <span className={`m-num text-[13px] font-semibold ${c.amountCents >= 0 ? 'text-accent-deep' : 'text-warning'}`}>
                  {fmt(c.amountCents, currency, { sign: true })}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <p className="px-1 text-[12px] text-ink-4">{t('goals.noHistory')}</p>
        )}
      </div>

      {/* fund / withdraw */}
      <Sheet
        open={fundOpen !== null}
        onOpenChange={(open) => {
          if (open) return;
          setFundOpen(null);
          setAttempted(false);
        }}
        title={t(fundOpen === 'withdraw' ? 'goals.withdraw' : 'goals.fund')}
        size="form"
      >
        <div className="flex flex-col gap-3 pt-1">
          <input
            data-testid="goalfund-amount"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            aria-invalid={attempted && fundBad}
            className={`h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4${blockerRing(attempted && fundBad)}`}
          />
          {/* #195 r2 (user): the blocker sits AT the field */}
          <FormBlockerNote show={attempted && fundBad} text={t('form.needAmount')} testId="goalfund-save-blocker" />
          {fundOpen === 'fund' && (
            <p className="px-1 text-[12px] text-ink-3" data-testid="goalfund-pool">
              {t('goals.poolAvailable', { amount: balance(Math.max(0, available)) })}
            </p>
          )}
          <FormBlockerNote
            show={attempted && !fundBad && fundOverPool}
            text={t('goals.poolExceeded', { amount: balance(Math.max(0, available)) })}
            testId="goalfund-pool-blocker"
          />
          <input
            data-testid="goalfund-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('goals.notePlaceholder')}
            className="h-11 w-full rounded-input border border-line bg-surface px-4 text-[14px] text-ink outline-none placeholder:text-ink-4"
          />
          <Button
            data-testid="goalfund-save"
            onClick={() => {
              if (fundBad || fundOverPool) {
                setAttempted(true);
                return;
              }
              void submitFunding();
            }}
          >
            {t(fundOpen === 'withdraw' ? 'goals.withdraw' : 'goals.fund')}
          </Button>
        </div>
      </Sheet>

      <GoalFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
    </div>
  );
}
