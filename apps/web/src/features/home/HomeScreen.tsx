import { useEffect, useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate } from '@tanstack/react-router';
import { OVERVIEW_KINDS, overviewSummary } from '@/domain/overview';
import type { OverviewKind, OverviewSummary } from '@/domain/overview';
import { periodHistory } from '@/domain/periods';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
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

  const accounts = useLiveQuery(
    () => db.accounts.where('spaceId').equals(spaceId).filter((a) => a.deleted === 0).toArray(),
    [spaceId],
  );
  const recentTxs = useLiveQuery(
    () =>
      db.transactions
        .where('[spaceId+date]')
        .between([spaceId, ''], [spaceId, '￿'])
        .reverse()
        .filter((tx) => tx.deleted === 0)
        .limit(5)
        .toArray(),
    [spaceId],
  );

  const needsOnboarding = useLiveQuery(() => db.meta.get('needsOnboarding'), []);
  useEffect(() => {
    if (needsOnboarding?.value === true) void navigate({ to: '/onboarding' });
  }, [needsOnboarding, navigate]);

  const reviewCount = useLiveQuery(
    () =>
      db.transactions
        .where('spaceId')
        .equals(spaceId)
        .filter((tx) => tx.deleted === 0 && tx.needsReview === 1)
        .count(),
    [spaceId],
  );

  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const totalCents = (accounts ?? []).reduce((sum, a) => sum + a.balanceCents, 0);
  const currency = space?.currency ?? accounts?.[0]?.currency ?? 'EUR';

  // this period's overview (earned / spent / saved / invested)
  const allTxs = useLiveQuery(
    () => db.transactions.where('spaceId').equals(spaceId).filter((tx) => tx.deleted === 0).toArray(),
    [spaceId],
  );
  const summary = useMemo(() => {
    const [period] = periodHistory(space?.periodType ?? 'month', space?.periodDay ?? 1, 1);
    const accountsById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return overviewSummary(allTxs ?? [], accountsById, period);
  }, [allTxs, accounts, space?.periodType, space?.periodDay]);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-home">
      <AppBar large title={t('tab.home')} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="rounded-card bg-brand px-5 py-6 text-on-brand">
          <div className="text-xs font-medium uppercase tracking-wider opacity-70">{t('home.balance')}</div>
          <div className="m-num mt-1 text-4xl" data-testid="home-total-balance">
            {accounts ? fmtCents(totalCents, currency, lang) : '—'}
          </div>
          <div className="mt-3 flex flex-col gap-1">
            {(accounts ?? []).map((a) => (
              <div key={a.id} className="flex items-center justify-between text-[13px] opacity-90">
                <span className="truncate">{a.name}</span>
                <span className="m-num">{fmtCents(a.balanceCents, a.currency, lang)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* overview tiles: this period, tap to drill into categories */}
        <div className="mt-4 grid grid-cols-2 gap-2">
          {OVERVIEW_KINDS.map((kind) => (
            <button
              key={kind}
              data-testid={`home-overview-${kind}`}
              onClick={() => void navigate({ to: '/overview/$kind', params: { kind } })}
              className="m-tap flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-3.5 text-left"
            >
              <span
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
                style={{ background: `color-mix(in srgb, ${TILE_META[kind].color} 14%, transparent)`, color: TILE_META[kind].color }}
              >
                <Icon name={TILE_META[kind].icon} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[11px] font-medium text-ink-3">{t(`overview.${kind}` as TranslationKey)}</span>
                <span className="m-num block truncate text-[15px] font-semibold text-ink">
                  {fmtCents(summary[TILE_META[kind].field], currency, lang)}
                </span>
              </span>
            </button>
          ))}
        </div>

        {(reviewCount ?? 0) > 0 && (
          <button
            data-testid="home-review-banner"
            onClick={() => void navigate({ to: '/review' })}
            className="m-tap mt-4 flex w-full items-center gap-3 rounded-card border border-line bg-warning-soft px-4 py-3.5 text-left"
          >
            <Icon name="progress-check" size={22} color="var(--m-warning)" />
            <span className="flex-1 text-[14px] font-medium text-ink">
              {t('review.title')} · {reviewCount}
            </span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
        )}

        <div className="m-cap mt-6 mb-1 px-1">{t('tab.transactions')}</div>
        <div className="rounded-card border border-line bg-surface px-3 py-1">
          {(recentTxs ?? []).map((tx) => (
            <TxRow
              key={tx.id}
              tx={tx}
              onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
