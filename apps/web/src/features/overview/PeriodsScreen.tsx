import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import type { Lang } from '@/i18n';
import { useData } from '@/app/data';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import type { SpacePeriodType } from '@/db/types';
import { useQuery } from '@/db/useQuery';
import { OVERVIEW_KINDS, overviewSummarySeries } from '@/domain/overview';
import type { OverviewKind } from '@/domain/overview';
import { periodHistoryCovering } from '@/domain/periods';
import type { Period } from '@/domain/periods';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { MultiLine } from '@/ui/charts/MultiLine';
import { rememberPeriod } from './periodMemory';
import { TILE_META, TONE_CLASS, deltaTone, tileValueClass } from './tileMeta';

/** how far back the history reaches at most: three years of monthly periods */
export const MAX_PERIODS = 36;

/** the drill-down walks this many periods (OverviewScreen's PERIOD_COUNT) —
 *  a card opens it on the same period whenever that period is in its window */
const DRILL_PERIODS = 6;

export interface PeriodDelta {
  cents: number;
  /** whole percent against the period before; null when there was nothing to compare with */
  pct: number | null;
}

/** the change against the period before — null for the first period on record */
export function periodDelta(values: readonly number[], index: number): PeriodDelta | null {
  if (index <= 0 || index >= values.length) return null;
  const previous = values[index - 1];
  const cents = values[index] - previous;
  return { cents, pct: previous === 0 ? null : Math.round((cents / Math.abs(previous)) * 100) };
}

/**
 * Sparse x labels: the newest period is always labelled and every k-th one
 * before it, so twelve periods read Jan · Mar · May … the way the recurring
 * chart does. Monthly periods are named by the month they END in (21 Sep –
 * 20 Oct is "Oct"); weekly ones by the day they start.
 */
export function periodLabels(periods: readonly Period[], periodType: SpacePeriodType, lang: Lang): string[] {
  const n = periods.length;
  const every = Math.max(1, Math.ceil(n / 6));
  const weekly = periodType === 'week' || periodType === 'biweekly';
  return periods.map((p, i) => {
    if ((n - 1 - i) % every !== 0) return '';
    const date = new Date(weekly ? p.start : p.end);
    return weekly
      ? date.toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' })
      : date.toLocaleDateString(LOCALES[lang], { month: 'short' });
  });
}

type Translate = ReturnType<typeof useLang>['t'];

function deltaText(delta: PeriodDelta | null, money: (cents: number) => string, t: Translate): string {
  if (delta === null) return t('periods.noPrevious');
  if (delta.cents === 0) return t('periods.same');
  const arrow = delta.cents > 0 ? '▲' : '▼';
  const pct = delta.pct === null ? '' : ` · ${delta.pct > 0 ? '+' : ''}${delta.pct}%`;
  return `${arrow} ${money(Math.abs(delta.cents))}${pct} ${t('periods.vsPrevious')}`;
}

/**
 * Every period side by side (user request 2026-10-06): Home's six tiles for
 * any period on record, a pager to walk back, and one chart per tile over
 * the whole history — closed periods solid, the running one dashed as
 * "so far", the recurring chart's language. A dot on any chart selects
 * that period everywhere; a tile opens the drill-down behind it.
 */
export function PeriodsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const accounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();
  const { fmt } = useDisplayMoney();
  const currency = space?.currency ?? 'EUR';
  const periodType = space?.periodType ?? 'month';
  const periodDay = space?.periodDay ?? 1;

  const earliest = useMemo(() => {
    let first: string | null = null;
    for (const tx of allTxs ?? []) {
      if (tx.deleted === 0 && (first === null || tx.date < first)) first = tx.date;
    }
    return first;
  }, [allTxs]);
  const periods = useMemo(
    () => periodHistoryCovering(periodType, periodDay, earliest, { cap: MAX_PERIODS }),
    [periodType, periodDay, earliest],
  );
  const series = useMemo(() => {
    const accountsById = new Map((accounts ?? []).map((a) => [a.id, a]));
    return overviewSummarySeries(allTxs ?? [], accountsById, periods);
  }, [allTxs, accounts, periods]);

  // the selection is the period's START, never an index: the history grows
  // once the rows arrive, and null keeps pointing at the newest period
  const [selectedStart, setSelectedStart] = useState<string | null>(null);
  const last = periods.length - 1;
  const found = selectedStart === null ? -1 : periods.findIndex((p) => p.start === selectedStart);
  const index = found < 0 ? last : found;
  const selected = periods[index];
  const select = (i: number) => setSelectedStart(i >= last ? null : periods[Math.max(0, i)].start);

  const fmtShort = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  const money = (cents: number) => fmt(cents, currency);
  const labels = useMemo(() => periodLabels(periods, periodType, lang), [periods, periodType, lang]);
  const captionFor = (i: number): string => {
    if (i === last) return t('periods.thisPeriod');
    if (i === last - 1) return t('periods.previous');
    return t('periods.ago', { n: last - i });
  };

  const open = (kind: OverviewKind) => {
    const drillIndex = DRILL_PERIODS - 1 - (last - index);
    if (drillIndex >= 0) rememberPeriod(kind, drillIndex);
    void navigate({ to: '/overview/$kind', params: { kind } });
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-periods">
      <AppBar
        title={t('periods.title')}
        leading={
          <IconButton label={t('action.back')} testId="periods-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="periods" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="mt-2 flex items-center gap-2 rounded-card border border-line bg-surface px-2 py-2" data-testid="periods-pager">
          <button
            type="button"
            data-testid="periods-older"
            aria-label={t('periods.older')}
            disabled={index === 0}
            onClick={() => select(index - 1)}
            className="m-tap flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-ink disabled:opacity-30"
          >
            <Icon name="chevron-left" size={22} />
          </button>
          <div className="min-w-0 flex-1 text-center">
            <div className="text-[14px] font-semibold text-ink" data-testid="periods-range">
              {fmtShort(selected.start)} – {fmtShort(selected.end)}
            </div>
            <div className="text-[11px] text-ink-3" data-testid="periods-caption">
              {captionFor(index)}
            </div>
          </div>
          <button
            type="button"
            data-testid="periods-newer"
            aria-label={t('periods.newer')}
            disabled={index === last}
            onClick={() => select(index + 1)}
            className="m-tap flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-transparent text-ink disabled:opacity-30"
          >
            <Icon name="chevron-right" size={22} />
          </button>
        </div>
        <p className="mt-3 px-1 text-[12px] text-ink-3">{t('periods.intro')}</p>
        <div className="mt-2 flex items-center gap-4 px-1 text-[11px] text-ink-3" data-testid="periods-legend">
          <span className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-[2px] w-[14px] rounded" style={{ background: 'var(--m-ink-2)' }} />
            {t('periods.legendComplete')}
          </span>
          <span className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-[2px] w-[14px] rounded opacity-70"
              style={{ backgroundImage: 'repeating-linear-gradient(90deg, var(--m-ink-4) 0 4px, transparent 4px 7px)' }}
            />
            {t('periods.legendSoFar')}
          </span>
        </div>
        <div className="mt-2 grid gap-3 md:grid-cols-2">
          {OVERVIEW_KINDS.map((kind) => (
            <MetricCard
              key={kind}
              kind={kind}
              values={series.map((s) => s[TILE_META[kind].field])}
              index={index}
              labels={labels}
              money={money}
              onSelect={select}
              onOpen={() => open(kind)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function MetricCard({
  kind,
  values,
  index,
  labels,
  money,
  onSelect,
  onOpen,
}: Readonly<{
  kind: OverviewKind;
  /** one amount per period, newest last */
  values: readonly number[];
  index: number;
  labels: string[];
  money: (cents: number) => string;
  onSelect: (index: number) => void;
  onOpen: () => void;
}>) {
  const { t } = useLang();
  const last = values.length - 1;
  const color = TILE_META[kind].color;
  // closed periods draw solid; the running one hangs off the last closed
  // point as a dashed "so far" that owns the newest dot (the recurring
  // chart's estimate trick, with the roles the other way round)
  const series = useMemo(
    () => [
      { values: values.map((c, i) => (i < last ? c / 100 : null)), color },
      { values: values.map((c, i) => (i >= last - 1 ? c / 100 : null)), color, dashed: true, skipDotAt: last - 1 },
    ],
    [values, last, color],
  );
  const selected = index === last ? { seriesIndex: 1, pointIndex: last } : { seriesIndex: 0, pointIndex: index };
  const value = values[index] ?? 0;
  const delta = periodDelta(values, index);
  const tone = deltaTone(kind, delta?.cents ?? 0);
  return (
    <section className="rounded-card border border-line bg-surface p-4" data-testid={`periods-card-${kind}`}>
      <button
        type="button"
        data-testid={`periods-open-${kind}`}
        onClick={onOpen}
        className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent p-0 text-left"
      >
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
          style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
        >
          <Icon name={TILE_META[kind].icon} size={16} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[11px] font-medium text-ink-3">{t(`overview.${kind}`)}</span>
          <span className={`m-num block truncate text-[16px] font-semibold ${tileValueClass(kind, value)}`} data-testid={`periods-value-${kind}`}>
            {money(value)}
          </span>
        </span>
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>
      <div className={`mt-1 text-[11px] ${TONE_CLASS[tone]}`} data-testid={`periods-delta-${kind}`}>
        {deltaText(delta, money, t)}
      </div>
      <div className="mt-2">
        <MultiLine
          series={series}
          labels={labels}
          height={96}
          testId={`periods-chart-${kind}`}
          onPointClick={(_series, point) => onSelect(point)}
          selected={selected}
        />
      </div>
    </section>
  );
}
