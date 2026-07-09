import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { OVERVIEW_KINDS, overviewSummary } from '@/domain/overview';
import type { OverviewKind, OverviewSummary } from '@/domain/overview';
import { periodHistory } from '@/domain/periods';
import { addDays, nextDueDate } from '@/domain/recurring';
import { RecurringVisual } from '@/features/recurring/RecurringVisual';
import type { RecurringRow } from '@/db/types';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { OfflineIndicator } from '@/app/OfflineBanner';
import { NotificationsBell } from './NotificationsBell';
import { SpaceSwitcher } from '@/features/spaces/SpaceSwitcher';
import { useBudgetStatuses } from '@/application/budgets';
import { budgetColor, ratioPct } from '@/features/budgets/budgetUi';
import { fmtCents } from '@/lib/money';
import { AppBar } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';

const TILE_META: Record<OverviewKind, { icon: string; color: string; field: keyof OverviewSummary }> = {
  income: { icon: 'cash-plus', color: 'var(--m-accent)', field: 'incomeCents' },
  expense: { icon: 'cash-remove', color: 'var(--m-negative)', field: 'expenseCents' },
  saving: { icon: 'piggy-bank-outline', color: '#A8782B', field: 'savingCents' },
  investment: { icon: 'chart-timeline-variant', color: '#673AB7', field: 'investmentCents' },
};

export function HomeScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const navigate = useNavigate();
  const [accountsOpen, setAccountsOpen] = useState(false);

  const accounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();
  const recentTxs = useMemo(
    () => allTxs && [...allTxs].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5),
    [allTxs],
  );
  const reviewCount = useMemo(() => allTxs?.filter((tx) => tx.needsReview === 1).length, [allTxs]);

  const needsOnboarding = useLiveQuery(() => db.meta.get('needsOnboarding'), []);
  useEffect(() => {
    if (needsOnboarding?.value === true) void navigate({ to: '/onboarding' });
  }, [needsOnboarding, navigate]);

  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const totalCents = (accounts ?? []).reduce((sum, a) => sum + a.balanceCents, 0);
  const currency = space?.currency ?? accounts?.[0]?.currency ?? 'EUR';
  const period = useMemo(
    () => periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, 1)[0],
    [space?.periodType, space?.periodDay],
  );
  const summary = useMemo(() => {
    const accountsById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return overviewSummary(allTxs ?? [], accountsById, period);
  }, [allTxs, accounts, period]);
  const fmtShort = (iso: string) =>
    new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });

  // landing-zone block: recurring costs due within a week (user decision:
  // the home block shows only the upcoming ones; the tab has the rest)
  const recurrings = useLiveQuery(
    () => db.recurrings.filter((r) => r.deleted === 0 && r.spaceId === spaceId && r.active === 1).toArray(),
    [db, spaceId],
  );
  // landing-zone block: the 3 most urgent budgets (approved: 3)
  const budgetStatuses = useBudgetStatuses();
  const urgentBudgets = useMemo(() => (budgetStatuses ?? []).slice(0, 3), [budgetStatuses]);
  const upcoming = useMemo(() => {
    const today = localToday();
    const horizon = addDays(today, 7);
    return (recurrings ?? [])
      .map((rec) => ({ rec, nextDue: nextDueDate(rec, today) }))
      .filter((u): u is { rec: RecurringRow; nextDue: string } => u.nextDue !== null && u.nextDue <= horizon)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
      .slice(0, 4);
  }, [recurrings]);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-home">
      <AppBar
        large
        title={t('tab.home')}
        trailing={
          <>
            <OfflineIndicator />
            <NotificationsBell />
            <SpaceSwitcher />
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* slim balance band: one line; accounts fold out on tap */}
        <button
          data-testid="home-balance-band"
          onClick={() => setAccountsOpen((v) => !v)}
          className="m-tap w-full rounded-card border-none bg-brand px-5 py-4 text-left text-on-brand"
        >
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-xs font-medium tracking-wider uppercase opacity-70">{t('home.balance')}</span>
            <Icon name={accountsOpen ? 'chevron-up' : 'chevron-down'} size={16} color="currentColor" />
          </div>
          <div className="m-num mt-0.5 text-[28px]" data-testid="home-total-balance">
            {accounts ? fmtCents(totalCents, currency, lang) : '—'}
          </div>
          {accountsOpen && (
            <div className="mt-2 flex flex-col gap-1" data-testid="home-balance-accounts">
              {(accounts ?? []).map((a) => (
                <div key={a.id} className="flex items-center justify-between text-[13px] opacity-90">
                  <span className="truncate">{a.name}</span>
                  <span className="m-num">{fmtCents(a.balanceCents, a.currency, lang)}</span>
                </div>
              ))}
            </div>
          )}
        </button>

        {/* landing-zone block: this period's overview. Future blocks
            (goals, budgets, events…) follow this same compact pattern. */}
        <div className="m-cap mt-5 mb-1 flex items-baseline justify-between px-1">
          <span>{t('overview.thisPeriod')}</span>
          <span className="text-[10px] font-medium normal-case text-ink-4" data-testid="home-period-range">
            {fmtShort(period.start)} – {fmtShort(period.end)}
          </span>
        </div>
        <div className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-surface">
          {OVERVIEW_KINDS.map((kind, i) => (
            <button
              key={kind}
              data-testid={`home-overview-${kind}`}
              onClick={() => void navigate({ to: '/overview/$kind', params: { kind } })}
              className={`m-tap flex items-center gap-2.5 border-none bg-transparent px-4 py-3 text-left ${
                i % 2 === 1 ? 'border-l border-l-line-2' : ''
              } ${i > 1 ? 'border-t border-t-line-2' : ''}`}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                style={{ background: `color-mix(in srgb, ${TILE_META[kind].color} 14%, transparent)`, color: TILE_META[kind].color }}
              >
                <Icon name={TILE_META[kind].icon} size={15} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[10px] font-medium text-ink-3">{t(`overview.${kind}`)}</span>
                <span className="m-num block truncate text-[13px] font-semibold text-ink">
                  {fmtCents(summary[TILE_META[kind].field], currency, lang)}
                </span>
              </span>
            </button>
          ))}
        </div>

        {/* review call-to-action: important enough to be its own card —
            the quiet list row was too easy to scroll past */}
        {(reviewCount ?? 0) > 0 && (
          <button
            data-testid="home-review-banner"
            onClick={() => void navigate({ to: '/review' })}
            className="m-tap mt-5 flex w-full items-center gap-3 rounded-card border border-warning bg-warning-soft px-4 py-3.5 text-left"
          >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface">
              <Icon name="progress-check" size={20} color="var(--m-warning)" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-semibold text-ink">{t('review.title')}</span>
              <span className="block text-[12px] text-ink-3">{t('home.reviewSub', { n: reviewCount ?? 0 })}</span>
            </span>
            <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-warning px-2 text-[12px] font-bold text-white">
              {reviewCount}
            </span>
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        )}

        {/* landing-zone block: the budgets that need attention, worst first */}
        {urgentBudgets.length > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 flex items-baseline justify-between px-1">
              <span>{t('budgets.title')}</span>
              <button
                data-testid="home-budgets-all"
                onClick={() => void navigate({ to: '/budgets' })}
                className="m-tap border-none bg-transparent text-[10px] font-medium normal-case text-ink-4"
              >
                {t('action.seeAll')}
              </button>
            </div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="home-budgets">
              {urgentBudgets.map((status) => {
                const color = budgetColor(status.ratio);
                const over = status.ratio > 1;
                return (
                  <button
                    key={status.budget.id}
                    data-testid={`home-budget-${status.budget.id}`}
                    onClick={() => void navigate({ to: '/budgets/$budgetId', params: { budgetId: status.budget.id } })}
                    className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-2.5 text-left last:border-0"
                  >
                    <Icon name={status.budget.icon ?? 'wallet-outline'} size={17} color={color} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-[13px] font-medium text-ink">{status.budget.name}</span>
                        <span className="m-num shrink-0 text-[12px] font-semibold" style={{ color }}>
                          {t(over ? 'budgets.over' : 'budgets.left', {
                            amount: fmtCents(Math.abs(status.leftCents), currency, lang),
                          })}
                        </span>
                      </span>
                      <span className="mt-1 block h-1 overflow-hidden rounded-full bg-bg-2">
                        <span className="block h-full rounded-full" style={{ width: `${ratioPct(status)}%`, background: color }} />
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {upcoming.length > 0 && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">{t('recurring.upcoming')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="home-upcoming">
              {upcoming.map(({ rec, nextDue }) => (
                <button
                  key={rec.id}
                  data-testid={`home-upcoming-${rec.id}`}
                  onClick={() => void navigate({ to: '/recurring/$recId', params: { recId: rec.id } })}
                  className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-2.5 text-left last:border-0"
                >
                  <RecurringVisual rec={rec} size={16} active={false} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-ink">{rec.name}</span>
                    <span className="block text-[11px] text-ink-4">{fmtShort(nextDue)}</span>
                  </span>
                  <span className="m-num text-[13px] font-semibold text-ink">
                    {fmtCents(rec.amountCents, currency, lang)}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="m-cap mt-5 mb-1 px-1">{t('tab.transactions')}</div>
        <div className="rounded-card border border-line bg-surface px-3 py-1">
          {(recentTxs ?? []).map((tx) => (
            <TxRow
              key={tx.id}
              tx={tx}
              showDate
              onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
