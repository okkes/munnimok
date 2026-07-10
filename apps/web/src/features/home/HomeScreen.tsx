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
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { InstallHint } from '@/features/help/InstallHint';
import { NotificationsBell } from './NotificationsBell';
import { eventPicture } from '@/features/events/EventsScreen';
import { HomeCustomizeSheet, resolveHomeBlocks } from './HomeCustomizeSheet';
import type { HomeBlockId } from './HomeCustomizeSheet';
import { SpaceSwitcher } from '@/features/spaces/SpaceSwitcher';
import { useBudgetStatuses, useBudgets } from '@/application/budgets';
import { useEvents } from '@/application/events';
import { useGoals } from '@/application/goals';
import { useDebtStatuses } from '@/application/debts';
import { useAllocations } from '@/application/allocation';
import { usePortfolio } from '@/application/portfolio';
import { useInsights } from '@/application/insights';
import { useNewTransactions } from '@/application/newTxs';
import { eventSpentCents } from '@/domain/events';
import { goalProgress } from '@/domain/goals';
import { debtsOverview } from '@/domain/debts';
import { toAllocateCents } from '@/domain/allocation';
import { budgetColor, ratioPct } from '@/features/budgets/budgetUi';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { ProgressBar, Tile } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';

const TILE_META: Record<OverviewKind, { icon: string; color: string; field: keyof OverviewSummary }> = {
  income: { icon: 'cash-plus', color: 'var(--m-accent)', field: 'incomeCents' },
  expense: { icon: 'cash-remove', color: 'var(--m-negative)', field: 'expenseCents' },
  saving: { icon: 'piggy-bank-outline', color: 'var(--m-warning)', field: 'savingCents' },
  investment: { icon: 'chart-timeline-variant', color: 'var(--m-special)', field: 'investmentCents' },
};

export function HomeScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const navigate = useNavigate();
  const [accountsOpen, setAccountsOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  const accounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();
  const { newTxs, ackAll } = useNewTransactions(allTxs);
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
  const budgets = useBudgets();
  const urgentBudgets = useMemo(() => (budgetStatuses ?? []).slice(0, 3), [budgetStatuses]);
  const hasBudgets = (budgets?.length ?? 0) > 0;
  const upcoming = useMemo(() => {
    const today = localToday();
    const horizon = addDays(today, 7);
    return (recurrings ?? [])
      .map((rec) => ({ rec, nextDue: nextDueDate(rec, today) }))
      .filter((u): u is { rec: RecurringRow; nextDue: string } => u.nextDue !== null && u.nextDue <= horizon)
      .sort((a, b) => a.nextDue.localeCompare(b.nextDue))
      .slice(0, 4);
  }, [recurrings]);

  // landing-zone blocks that only appear once the feature is in use.
  // one event only: running now, else the next upcoming, else the latest
  const events = useEvents();
  const featuredEvent = useMemo(() => {
    const today = localToday();
    const active = (events ?? []).filter((e) => e.archived !== 1);
    const running = active.find((e) => e.from && e.from <= today && (!e.to || e.to >= today));
    if (running) return running;
    const upcoming = active
      .filter((e) => e.from && e.from > today)
      .sort((a, b) => a.from!.localeCompare(b.from!))[0];
    if (upcoming) return upcoming;
    return active[0];
  }, [events]);
  const goals = useGoals();
  const topGoals = useMemo(
    () =>
      (goals ?? [])
        .filter((g) => g.archived !== 1)
        .sort((a, b) => goalProgress(b) - goalProgress(a))
        .slice(0, 2),
    [goals],
  );
  const debtStatuses = useDebtStatuses();
  const activeDebts = useMemo(() => (debtStatuses ?? []).filter((s) => s.debt.archived !== 1), [debtStatuses]);
  const debtTotals = useMemo(() => {
    const accountsById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return debtsOverview(activeDebts.map((s) => s.debt), accountsById);
  }, [activeDebts, accounts]);
  // insights block: the top undismissed finding
  const insights = useInsights();
  // portfolio block: only once holdings exist
  const portfolio = usePortfolio();
  const hasHoldings = (portfolio?.views ?? []).some((v) => v.holding.archived !== 1);
  // allocation block: only once the space actually allocates
  const allocations = useAllocations();
  const allocLeft = useMemo(() => {
    if (!allocations?.length) return null;
    const history = periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, 24);
    const starts = new Set(allocations.map((a) => a.periodStart));
    const first = history.findIndex((p) => starts.has(p.start));
    const window = first === -1 ? history.slice(-1) : history.slice(first);
    const accountsById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return toAllocateCents(window, allTxs ?? [], accountsById, allocations);
  }, [allocations, space?.periodType, space?.periodDay, allTxs, accounts]);

  // each landing-zone block renders through this registry so the
  // per-space layout (order + visibility) can rearrange them
  const blockRenderers: Record<HomeBlockId, () => React.ReactNode> = {
    overview: renderOverviewBlock,
    review: renderReviewBlock,
    insights: renderInsightsBlock,
    budgets: renderBudgetsBlock,
    allocation: renderAllocationBlock,
    upcoming: renderUpcomingBlock,
    events: renderEventsBlock,
    goals: renderGoalsBlock,
    debts: renderDebtsBlock,
    portfolio: renderPortfolioBlock,
    transactions: renderTransactionsBlock,
  };
  const layout = resolveHomeBlocks(space);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-home">
      <AppBar
        large
        title={t('tab.home')}
        trailing={
          <>
            <OfflineIndicator />
            <NotificationsBell />
            <HelpButton tourId="home" />
            <IconButton label={t('home.customize')} testId="home-customize" onClick={() => setCustomizeOpen(true)}>
              <Icon name="tune-variant" size={19} />
            </IconButton>
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

        <InstallHint />
        <IntroCard tourId="home" />

        {layout.filter((entry) => !entry.hidden).map((entry) => (
          <div key={entry.id}>{blockRenderers[entry.id]()}</div>
        ))}
      </div>

      <HomeCustomizeSheet open={customizeOpen} onOpenChange={setCustomizeOpen} space={space} />
    </div>
  );

  function renderOverviewBlock() {
    return (
      <>
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
      </>
    );
  }

  function renderReviewBlock() {
    // review call-to-action: important enough to be its own card —
    // the quiet list row was too easy to scroll past
    if ((reviewCount ?? 0) === 0) return null;
    return (
      <button
        data-testid="home-review-banner"
        onClick={() => void navigate({ to: '/review' })}
        className="m-tap mt-5 flex w-full items-center gap-3 rounded-card border border-warning bg-warning-soft px-4 py-3.5 text-left"
      >
        <Tile icon="progress-check" bg="var(--m-surface)" color="var(--m-warning)" />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-ink">{t('review.title')}</span>
          <span className="block text-[12px] text-ink-3">{t('home.reviewSub', { n: reviewCount ?? 0 })}</span>
        </span>
        <span className="flex h-7 min-w-7 items-center justify-center rounded-full bg-warning px-2 text-[12px] font-bold text-white">
          {reviewCount}
        </span>
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>
    );
  }

  function renderBudgetsBlock() {
    // never made a budget? a quiet get-started teaser instead of silence —
    // hideable like any block via Customize Home
    if (!hasBudgets) {
      return (
        <button
          data-testid="home-budgets-teaser"
          onClick={() => void navigate({ to: '/budgets' })}
          className="m-tap mt-5 flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-surface px-4 py-3.5 text-left"
        >
          <Tile icon="wallet-outline" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] font-semibold text-ink">{t('home.budgetsTeaserTitle')}</span>
            <span className="block text-[12px] text-ink-3">{t('home.budgetsTeaserSub')}</span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
        </button>
      );
    }
    if (urgentBudgets.length === 0) return null;
    return (
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
                  <ProgressBar className="mt-1" size="sm" value={ratioPct(status) / 100} color={color} />
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  function renderUpcomingBlock() {
    if (upcoming.length === 0) return null;
    return (
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
    );
  }

  function renderAllocationBlock() {
    if (allocLeft === null) return null;
    let color = 'var(--m-warning)';
    if (allocLeft === 0) color = 'var(--m-accent-deep)';
    else if (allocLeft < 0) color = 'var(--m-negative)';
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('alloc.title')}</div>
        <button
          data-testid="home-allocation"
          onClick={() => void navigate({ to: '/allocate' })}
          className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
        >
          <Tile
            icon={allocLeft === 0 ? 'check-circle-outline' : 'cash-multiple'}
            bg={`color-mix(in srgb, ${color} 14%, transparent)`}
            color={color}
          />
          <span className="min-w-0 flex-1">
            <span className="m-num block text-[15px] font-semibold" style={{ color }}>
              {fmtCents(allocLeft, currency, lang)}
            </span>
            <span className="block text-[11px] text-ink-4">
              {allocLeft === 0 ? t('alloc.allAssigned') : t('alloc.toAllocate')}
            </span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
        </button>
      </>
    );
  }

  // the good features shouldn't hide in settings: unconfigured ones get
  // a quiet dashed door on the landing zone (hideable like any block)
  function renderTeaser(testId: string, icon: string, titleKey: Parameters<typeof t>[0], subKey: Parameters<typeof t>[0], to: string) {
    return (
      <button
        data-testid={testId}
        onClick={() => void navigate({ to })}
        className="m-tap mt-5 flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-surface px-4 py-3.5 text-left"
      >
        <Tile icon={icon} />
        <span className="min-w-0 flex-1">
          <span className="block text-[14px] font-semibold text-ink">{t(titleKey)}</span>
          <span className="block text-[12px] text-ink-3">{t(subKey)}</span>
        </span>
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>
    );
  }

  function renderEventsBlock() {
    if (!featuredEvent) {
      return events ? renderTeaser('home-events-teaser', 'party-popper', 'home.eventsTeaserTitle', 'home.eventsTeaserSub', '/events') : null;
    }
    const today = localToday();
    const spent = eventSpentCents(allTxs ?? [], featuredEvent.id);
    const from = featuredEvent.from;
    const running = !!from && from <= today && (!featuredEvent.to || featuredEvent.to >= today);
    let statusLine = t('events.latest');
    if (running) statusLine = t('events.runningNow');
    else if (from && from > today) statusLine = t('events.upcoming', { date: fmtShort(from) });
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('events.title')}</div>
        <button
          data-testid={`home-event-${featuredEvent.id}`}
          onClick={() => void navigate({ to: '/events/$eventId', params: { eventId: featuredEvent.id } })}
          className="m-tap w-full overflow-hidden rounded-card border border-line bg-surface p-0 text-left"
        >
          <span className="relative block h-20 w-full" data-testid="home-events">
            <img src={eventPicture(featuredEvent)} alt="" loading="lazy" className="h-full w-full object-cover" />
            <span className="absolute inset-x-0 bottom-0 flex items-baseline justify-between bg-gradient-to-t from-black/60 to-transparent px-3 pt-4 pb-1.5">
              <span className="truncate text-[14px] font-semibold text-white">{featuredEvent.name}</span>
              <span className="m-num shrink-0 pl-2 text-[13px] font-semibold text-white">{fmtCents(spent, currency, lang)}</span>
            </span>
          </span>
          <span className="block px-3 py-1.5 text-[11px] text-ink-4">{statusLine}</span>
        </button>
      </>
    );
  }

  function renderGoalsBlock() {
    if (topGoals.length === 0) {
      return goals ? renderTeaser('home-goals-teaser', 'flag-outline', 'home.goalsTeaserTitle', 'home.goalsTeaserSub', '/goals') : null;
    }
    return (
      <>
        <div className="m-cap mt-5 mb-1 flex items-baseline justify-between px-1">
          <span>{t('goals.title')}</span>
          <button
            data-testid="home-goals-all"
            onClick={() => void navigate({ to: '/goals' })}
            className="m-tap border-none bg-transparent text-[10px] font-medium normal-case text-ink-4"
          >
            {t('action.seeAll')}
          </button>
        </div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="home-goals">
          {topGoals.map((goal) => {
            const progress = goalProgress(goal);
            return (
              <button
                key={goal.id}
                data-testid={`home-goal-${goal.id}`}
                onClick={() => void navigate({ to: '/goals/$goalId', params: { goalId: goal.id } })}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-2.5 text-left last:border-0"
              >
                <Icon name={goal.icon ?? 'flag-outline'} size={17} color="var(--m-accent-deep)" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[13px] font-medium text-ink">{goal.name}</span>
                    <span className="m-num shrink-0 text-[12px] font-semibold text-accent-deep">
                      {Math.round(progress * 100)}%
                    </span>
                  </span>
                  <ProgressBar className="mt-1" size="sm" value={progress} />
                </span>
              </button>
            );
          })}
        </div>
      </>
    );
  }

  function renderDebtsBlock() {
    if (activeDebts.length === 0) {
      return debtStatuses ? renderTeaser('home-debts-teaser', 'hand-coin-outline', 'home.debtsTeaserTitle', 'home.debtsTeaserSub', '/debts') : null;
    }
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('debts.title')}</div>
        <button
          data-testid="home-debts"
          onClick={() => void navigate({ to: '/debts' })}
          className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
        >
          <Tile icon="hand-coin-outline" tone="negative" />
          <span className="min-w-0 flex-1">
            <span className="m-num block text-[15px] font-semibold text-ink">{fmtCents(debtTotals.totalOwedCents, currency, lang)}</span>
            <span className="block text-[11px] text-ink-4">
              {debtTotals.totalMonthlyCents > 0
                ? t('debts.perMonth', { amount: fmtCents(debtTotals.totalMonthlyCents, currency, lang) })
                : t('debts.count', { n: activeDebts.length })}
            </span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
        </button>
      </>
    );
  }

  function renderInsightsBlock() {
    if (!insights || insights.length === 0) return null;
    const top = insights[0];
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('ins.title')}</div>
        <button
          data-testid="home-insight"
          onClick={() => void navigate({ to: '/insights' })}
          className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
        >
          <Tile icon={top.icon} tone="warning" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[13px] font-medium text-ink">
              {t(top.titleKey, Object.fromEntries(Object.entries(top.params).map(([k, v]) => [k, typeof v === 'number' && !['n', 'x', 'months'].includes(k) ? fmtCents(v, currency, lang) : v])))}
            </span>
            <span className="block text-[11px] text-ink-4">{t('ins.homeSub', { n: insights.length })}</span>
          </span>
          <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
        </button>
      </>
    );
  }

  function renderPortfolioBlock() {
    if (portfolio && !hasHoldings) {
      return renderTeaser('home-portfolio-teaser', 'chart-timeline-variant', 'home.portfolioTeaserTitle', 'home.portfolioTeaserSub', '/portfolio');
    }
    if (!portfolio || !hasHoldings) return null;
    const day = portfolio.totals.dayChangeCents;
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('pf.title')}</div>
        <button
          data-testid="home-portfolio"
          onClick={() => void navigate({ to: '/portfolio' })}
          className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
        >
          <Tile icon="chart-timeline-variant" tone="special" />
          <span className="min-w-0 flex-1">
            <span className="m-num block text-[15px] font-semibold text-ink">{fmtCents(portfolio.totals.totalCents, currency, lang)}</span>
            {day !== null && (
              <span className="m-num block text-[11px]" style={{ color: day >= 0 ? 'var(--m-accent-deep)' : 'var(--m-negative)' }}>
                {fmtCents(day, currency, lang, { sign: true })} {t('pf.today')}
              </span>
            )}
          </span>
          <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
        </button>
      </>
    );
  }

  function renderTransactionsBlock() {
    // only what arrived since the last acknowledgement — the tab has
    // the full history; seeing all marks everything as seen
    if (newTxs.length === 0) return null;
    return (
      <>
        <div className="m-cap mt-5 mb-1 flex items-baseline justify-between px-1">
          <span>
            {t('home.newTxs')} · {newTxs.length}
          </span>
          <button
            data-testid="home-newtx-all"
            onClick={() => {
              void ackAll();
              void navigate({ to: '/transactions' });
            }}
            className="m-tap border-none bg-transparent text-[10px] font-medium normal-case text-ink-4"
          >
            {t('action.seeAll')}
          </button>
        </div>
        <div className="rounded-card border border-line bg-surface px-3 py-1" data-testid="home-newtxs">
          {newTxs.slice(0, 5).map((tx) => (
            <TxRow
              key={tx.id}
              tx={tx}
              showDate
              onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
            />
          ))}
        </div>
      </>
    );
  }
}
