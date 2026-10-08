import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { localToday, useRecurrings } from '@/application/recurring';
import { periodHistory } from '@/domain/periods';
import { minIso, netWorthSeries, trendLabels } from '@/domain/trends';
import { HelpButton } from '@/features/help/HelpButton';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Line } from '@/ui/charts/Line';
import { Icon } from '@/ui/Icon';
import { CashflowTab } from './CashflowTab';
import { SpendingTab } from './SpendingTab';

/** the tab ids double as testids (`trends-view-<id>`) — the gallery and the tour anchor on them */
type View = 'categories' | 'cashflow' | 'networth';
const PERIOD_COUNT = 12;
const NONE: never[] = [];

/**
 * Trends (design T1/T2, rebuilt 2026-10-08 on the user's remarks): the
 * Spending tab's cards (all expenses + custom graphs), the Cash flow tab's
 * balance line and range, and the reconstructed net-worth line — pure
 * client-side domain work. The whole trend follows the space's periods.
 */
export function TrendsScreen() {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
  const [view, setView] = useState<View>('categories');
  const [catId, setCatId] = useState<string | undefined>(undefined);

  const txs = useSpaceTransactions();
  const accounts = useSpaceAccounts();
  const recurrings = useRecurrings();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const today = localToday();
  const periodType = space?.periodType ?? 'month';
  const periodDay = space?.periodDay ?? 1;

  const periods = useMemo(() => periodHistory(periodType, periodDay, PERIOD_COUNT), [periodType, periodDay]);
  const labels = useMemo(() => trendLabels(periods, periodType, periodDay, LOCALES[lang]), [periods, periodType, periodDay, lang]);

  const worth = useMemo(() => {
    if (view !== 'networth') return [];
    // a running period samples "now", finished ones their end
    const dates = periods.map((p) => minIso(p.end, today));
    return netWorthSeries(accounts ?? [], txs ?? [], dates);
  }, [view, accounts, txs, periods, today]);

  const { fmt: fmtLens } = useDisplayMoney();
  const fmt = (cents: number, opts?: { sign?: boolean }) => fmtLens(cents, currency, opts);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-trends">
      <AppBar
        title={t('trends.title')}
        leading={
          <IconButton label={t('action.back')} testId="trends-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={<HelpButton tourId="trends" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        <div className="mt-1 flex rounded-xl bg-bg-2 p-0.5">
          {(
            [
              ['categories', t('trends.viewSpending')],
              ['cashflow', t('trends.viewCashflow')],
              ['networth', t('trends.viewNetworth')],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              data-testid={`trends-view-${value}`}
              onClick={() => setView(value)}
              className={`m-tap flex-1 rounded-[10px] border-none py-2 text-[12px] whitespace-nowrap ${
                view === value ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {view === 'categories' && (
          <SpendingTab
            space={space}
            periods={periods}
            labels={labels}
            txs={txs ?? NONE}
            today={today}
            currency={currency}
            catId={catId}
            onCatId={setCatId}
            fmt={fmt}
          />
        )}

        {view === 'cashflow' && (
          <CashflowTab
            periods={periods}
            periodType={periodType}
            periodDay={periodDay}
            txs={txs ?? NONE}
            accounts={accounts ?? NONE}
            recurrings={recurrings ?? NONE}
            today={today}
            fmt={fmt}
          />
        )}

        {view === 'networth' && (
          <div className="mt-4 rounded-card border border-line bg-surface p-4">
            <Line
              testId="trends-worth-chart"
              values={worth.map((point) => point.cents)}
              labels={labels}
              color="var(--m-accent-deep)"
            />
            <div className="mt-2 flex items-baseline justify-between text-[11px] text-ink-4">
              <span>{t('trends.worthNote')}</span>
              <span className="m-num text-[13px] font-semibold text-ink" data-testid="trends-worth-now">
                {fmt(worth.at(-1)?.cents ?? 0)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
