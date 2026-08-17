import { useEffect, useMemo, useState } from 'react';
import { attachScrollMemory } from '@/lib/scrollMemory';
import { useQuery } from '@/db/useQuery';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSpaceAccounts, useSpaceHistoryTransactions, useSpaceTransactions } from '@/application/transactions';
import { localToday, useDismissedKeys, useRecurringOps, useRecurrings } from '@/application/recurring';
import { computeRange, monthlyRecurringSeries, summarize } from '@/domain/recurring';
import type { RecurringComputed } from '@/domain/recurring';
import { detectPriceChange, yearlyCents } from '@/domain/recurringPrice';
import { detectRecurring } from '@/domain/detectRecurring';
import { looksLikeDebtCreditor } from '@/domain/detectDebts';
import { nextPeriod, periodHistory } from '@/domain/periods';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { RecurringFormSheet, emptyForm } from './RecurringFormSheet';
import type { FormState } from './RecurringFormSheet';
import { RecurringVisual, cadenceLabel } from './RecurringVisual';
import { HelpButton } from '@/features/help/HelpButton';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Chip, Pill, ProgressBar } from '@/ui/primitives';
import { MultiLine } from '@/ui/charts/MultiLine';

export function RecurringScreen() {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const recs = useRecurrings();
  const dismissed = useDismissedKeys();
  const txs = useSpaceTransactions();
  const ops = useRecurringOps();
  const navigate = useNavigate();

  // #188 (user): this year, next year and All join the range filter
  const [view, setView] = useState<'period' | 'next' | 'year' | 'nextyear' | 'all'>('period');
  const [formInitial, setFormInitial] = useState<FormState | null>(null);

  // pick up freshly imported payments the moment the screen opens
  useEffect(() => {
    void ops.reconcile().catch(() => undefined); // teardown-safe
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spaceId]);

  const today = localToday();
  const currency = space?.currency ?? 'EUR';
  const { fmt } = useDisplayMoney();
  const money = (cents: number) => fmt(cents, currency);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });

  const period = useMemo(
    () => periodHistory(space?.periodType ?? 'month', space?.periodDay || 1, 1)[0],
    [space?.periodType, space?.periodDay],
  );
  const upcoming = useMemo(
    () => nextPeriod(space?.periodType ?? 'month', space?.periodDay || 1),
    [space?.periodType, space?.periodDay],
  );
  const thisYear = Number(today.slice(0, 4));
  let range = period;
  if (view === 'next') range = upcoming;
  // 'all' borrows this year's range for the paid math; its LIST skips
  // the occurrence filter below (every recurring shows, user #188)
  else if (view === 'year' || view === 'all') range = { start: `${thisYear}-01-01`, end: `${thisYear}-12-31` };
  else if (view === 'nextyear') range = { start: `${thisYear + 1}-01-01`, end: `${thisYear + 1}-12-31` };

  const linkedByRec = useMemo(() => {
    const map = new Map<string, { date: string; amountCents: number }[]>();
    for (const tx of txs ?? []) {
      if (!tx.recurringId) continue;
      const list = map.get(tx.recurringId) ?? [];
      list.push({ date: tx.date, amountCents: tx.amountCents });
      map.set(tx.recurringId, list);
    }
    return map;
  }, [txs]);

  // #189: occurrences before the space's start date are unknowable —
  // their payments are older than the space shows, so they must not
  // read as "not paid yet"
  const computed = useMemo(
    () => computeRange(recs ?? [], linkedByRec, range.start, range.end, today, space?.historyStartDate),
    [recs, linkedByRec, range.start, range.end, today, space?.historyStartDate],
  );
  const summary = summarize(computed.filter((c) => c.rec.active === 1));

  // detection reads the FULL stored history (user design 2026-08-01):
  // yearly patterns live in the pre-start tail the display gate hides
  const historyTxs = useSpaceHistoryTransactions();
  const spaceAccounts = useSpaceAccounts();
  const suggestionCount = useMemo(() => {
    if (!historyTxs || !recs || !dismissed) return 0;
    // #192: loans own their merchant keys like recurring rows do
    const exclude = new Set([
      ...dismissed,
      ...recs.flatMap((r) => (r.merchantKey ? [r.merchantKey] : [])),
      ...(spaceAccounts ?? []).flatMap((a) => (a.merchantKey ? [a.merchantKey] : [])),
    ]);
    // #192 r2: known-lender patterns surface on the DEBTS screen — the
    // banner must promise only what this inbox actually shows
    return detectRecurring(historyTxs, { excludeKeys: exclude, today }).filter((s) => !looksLikeDebtCreditor(s.name))
      .length;
  }, [historyTxs, recs, spaceAccounts, dismissed, today]);

  // #188 (user ss): a recurring shows only in ranges it actually
  // OCCURS in — a yearly due Jan 2027 belongs to "next year" alone.
  // 'all' lists everything; a stray in-range payment keeps a row too.
  const occursHere = (c: RecurringComputed) => view === 'all' || c.occurrences > 0 || c.paidCents > 0;
  const fixed = computed.filter((c) => c.rec.kind === 'fixed' && c.rec.active === 1 && occursHere(c));
  const subs = computed.filter((c) => c.rec.kind === 'subscription' && c.rec.active === 1 && occursHere(c));
  const inactive = computed.filter((c) => c.rec.active !== 1);
  const empty = (recs?.length ?? 0) === 0 && suggestionCount === 0;

  const subtitleFor = (c: RecurringComputed): string => {
    if (view === 'period' && c.paid) return t('recurring.paidThisPeriod');
    // custom cadences say their rhythm; plain monthly/yearly say the due day
    const custom = c.rec.every === 'week' || (c.rec.everyN ?? 1) > 1;
    const parts = [custom ? cadenceLabel(c.rec, t) : t('recurring.dueDay2', { day: c.rec.dueDay })];
    if (c.nextDue) parts.push(t('recurring.next', { date: fmtDate(c.nextDue) }));
    if (c.rec.until) parts.push(t('recurring.ends', { date: fmtDate(c.rec.until) }));
    return parts.join(' · ');
  };

  // the toggle filters by date range — label it with the actual dates,
  // not the "period" word (cadences are independent of the space period)
  const rangeLabelFor = (r: { start: string; end: string }): string => {
    if (r.start.slice(5) === '01-01' && r.end.slice(5) === '12-31' && r.start.slice(0, 4) === r.end.slice(0, 4))
      return r.start.slice(0, 4);
    const [y, m] = r.start.split('-').map(Number);
    const fullMonth =
      r.start.slice(8) === '01' &&
      r.end.slice(0, 7) === r.start.slice(0, 7) &&
      Number(r.end.slice(8)) === new Date(y, m, 0).getDate();
    if (fullMonth) return new Date(r.start).toLocaleDateString(LOCALES[lang], { month: 'long' });
    const fmtShort = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
    return `${fmtShort(r.start)} – ${fmtShort(r.end)}`;
  };

  const renderRow = (c: RecurringComputed) => (
    <button
      key={c.rec.id}
      data-testid={`recurring-row-${c.rec.id}`}
      onClick={() => void navigate({ to: '/recurring/$recId', params: { recId: c.rec.id } })}
      className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
    >
      <span className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${c.paid && view === 'period' ? 'bg-accent-soft' : 'bg-bg-2'}`}>
        <RecurringVisual rec={c.rec} active={c.paid && view === 'period'} fill />
        {c.paid && view === 'period' && (
          <span className="absolute -right-1 -bottom-1 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-white ring-2 ring-surface">
            <Icon name="check" size={9} />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[14px] font-medium text-ink">{c.rec.name}</span>
          {c.rec.luxury === 1 && (
            <Pill tone="accent" caps>
              {t('recurring.luxury')}
            </Pill>
          )}
          {/* S2: a sustained price change wears its delta openly */}
          {(() => {
            const change = detectPriceChange(linkedByRec.get(c.rec.id) ?? []);
            if (!change) return null;
            const up = change.toCents > change.fromCents;
            return (
              <Pill tone={up ? 'warning' : 'accent'} testId={`recurring-pricechange-${c.rec.id}`}>
                {up ? '+' : '−'}
                {money(Math.abs(change.toCents - change.fromCents))}
              </Pill>
            );
          })()}
        </span>
        <span className="block truncate text-[11px] text-ink-4">{subtitleFor(c)}</span>
      </span>
      <span className="text-right">
        <span className="block font-mono text-[14px] font-semibold text-ink">{money(c.effectiveCents)}</span>
        <span className="block font-mono text-[10px] text-ink-4">{t('recurring.perYear', { amount: money(yearlyCents(c.rec)) })}</span>
      </span>
      <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
    </button>
  );

  const section = (labelKey: 'recurring.fixed' | 'recurring.subs' | 'recurring.inactive', rows: RecurringComputed[]) =>
    rows.length > 0 && (
      <>
        <div className="m-cap mt-5 mb-1 px-1">
          {t(labelKey)} · {rows.length}
        </div>
        <div className={`overflow-hidden rounded-card border border-line bg-surface ${labelKey === 'recurring.inactive' ? 'opacity-60' : ''}`}>
          {rows.map(renderRow)}
        </div>
      </>
    );

  const progress = summary.totalCents > 0 ? Math.min(1, summary.paidCents / summary.totalCents) : 0;
  // #167: a future range has no payments — only its total is a fact
  const futureView = view === 'next' || view === 'nextyear';

  // #168 (user): the year views plot the months — estimate vs actual,
  // each line toggleable on its own
  const [showEstimate, setShowEstimate] = useState(true);
  const [showActual, setShowActual] = useState(true);
  const yearView = view === 'year' || view === 'nextyear';
  const chartYear = view === 'nextyear' ? thisYear + 1 : thisYear;
  const monthly = useMemo(
    () => (yearView ? monthlyRecurringSeries(recs ?? [], linkedByRec, chartYear, today, space?.historyStartDate) : null),
    [yearView, recs, linkedByRec, chartYear, today, space?.historyStartDate],
  );
  const chartSeries = useMemo(() => {
    if (!monthly) return [];
    const list: { values: number[]; color: string; dashed?: boolean }[] = [];
    // cents → euros keeps the shared scale honest across both lines
    if (showEstimate) list.push({ values: monthly.expected.map((c) => c / 100), color: 'var(--m-ink-4)', dashed: true });
    if (showActual) list.push({ values: monthly.paid.map((c) => c / 100), color: 'var(--m-accent)' });
    return list;
  }, [monthly, showEstimate, showActual]);
  const monthLabels = useMemo(
    () =>
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0 ? new Date(chartYear, i, 1).toLocaleDateString(LOCALES[lang], { month: 'short' }) : '',
      ),
    [chartYear, lang],
  );

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-recurring">
      <AppBar
        large
        title={t('screen.recurring')}
        trailing={
          <>
            <HelpButton tourId="recurring" />
            <IconButton label={t('recurring.add')} testId="recurring-add" onClick={() => setFormInitial(emptyForm())}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div ref={(el) => attachScrollMemory(el, 'recurring')} className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* date-range filter (#188): current range / next range / this
            year / next year / all — five tabs scroll when tight */}
        <div className="mt-1 flex overflow-x-auto rounded-xl bg-bg-2 p-0.5">
          {(
            [
              ['period', rangeLabelFor(period)],
              ['next', rangeLabelFor(upcoming)],
              ['year', String(thisYear)],
              ['nextyear', String(thisYear + 1)],
              ['all', t('recurring.viewAll')],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              data-testid={`recurring-view-${v}`}
              onClick={() => setView(v)}
              className={`m-tap min-w-fit flex-1 rounded-[10px] border-none px-2.5 py-2 text-[12px] whitespace-nowrap ${
                view === v ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* detection inbox entry: one quiet notification, details behind it */}
        {suggestionCount > 0 && (
          <button
            data-testid="recurring-suggestions-banner"
            onClick={() => void navigate({ to: '/recurring/suggestions' })}
            className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-accent bg-accent-soft/40 px-4 py-3 text-left"
          >
            <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface">
              <Icon name="creation" size={17} color="var(--m-accent-deep)" />
              <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[9px] font-bold text-white">
                {suggestionCount}
              </span>
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink">{t('recurring.detected')}</span>
              <span className="block text-[11px] text-ink-3">{t('recurring.detectedSub', { n: suggestionCount })}</span>
            </span>
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        )}

        {/* summary card — 'all' is not a date range, so the range-bound
            numbers stand down and only the honest annual figure stays.
            #167 (user): FUTURE ranges have no payments yet — paid and
            remaining would always parrot 0 and the total, so they and
            the progress bar stand down; only the total speaks. */}
        <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="recurring-summary">
          {view !== 'all' && futureView && (
            <div data-testid="recurring-summary-future">
              <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t('recurring.total')}</div>
              <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{money(summary.totalCents)}</div>
            </div>
          )}
          {view !== 'all' && !futureView && (
            <>
              <div className="grid grid-cols-3 gap-3">
                {(
                  [
                    ['recurring.total', summary.totalCents, 'var(--m-ink)'],
                    ['recurring.paid', summary.paidCents, 'var(--m-accent-deep)'],
                    ['recurring.remaining', summary.remainingCents, summary.remainingCents > 0 ? 'var(--m-warning)' : 'var(--m-accent-deep)'],
                  ] as const
                ).map(([key, cents, color]) => (
                  <div key={key}>
                    <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t(key)}</div>
                    <div className="mt-0.5 font-mono text-[15px] font-semibold" style={{ color }}>
                      {money(cents)}
                    </div>
                  </div>
                ))}
              </div>
              <ProgressBar className="mt-3" value={progress} />
            </>
          )}
          {/* subscription intelligence S1: the honest annual figure */}
          <div className={`${view === 'all' ? '' : 'mt-3 '}text-[11px] text-ink-3`} data-testid="recurring-year-total">
            {t('recurring.perYearTotal', {
              amount: money((recs ?? []).filter((r) => r.active === 1).reduce((sum, r) => sum + yearlyCents(r), 0)),
            })}
          </div>
          {view !== 'all' && summary.luxuryCents > 0 && (
            <div className="mt-3 flex items-center gap-1.5 text-[11px] text-ink-3" data-testid="recurring-luxury-line">
              <Pill tone="accent" caps>
                {t('recurring.luxury')}
              </Pill>
              {t('recurring.luxuryNote', {
                period: money(summary.luxuryCents),
                year: money(view === 'year' || view === 'nextyear' ? summary.luxuryCents : summary.luxuryCents * 12),
              })}
            </div>
          )}
        </div>

        {/* #168: the year's monthly line chart — estimate and actual,
            each togglable; the card hides only when both are off */}
        {yearView && monthly && (
          <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="recurring-chart">
            <div className="mb-2 flex gap-2">
              <Chip testId="recurring-chart-est" selected={showEstimate} onClick={() => setShowEstimate((v) => !v)}>
                <span aria-hidden className="inline-block h-[2px] w-[14px] rounded bg-current opacity-70" style={{ backgroundImage: 'repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)' }} />
                {t('recurring.chartEstimate')}
              </Chip>
              <Chip testId="recurring-chart-act" selected={showActual} onClick={() => setShowActual((v) => !v)}>
                <span aria-hidden className="inline-block h-[2px] w-[14px] rounded bg-current" />
                {t('recurring.chartActual')}
              </Chip>
            </div>
            {chartSeries.length > 0 ? (
              <MultiLine series={chartSeries} labels={monthLabels} height={120} testId="recurring-chart-svg" />
            ) : (
              <p className="py-6 text-center text-[12px] text-ink-4">{t('recurring.chartAllOff')}</p>
            )}
          </div>
        )}

        {section('recurring.fixed', fixed)}
        {section('recurring.subs', subs)}
        {section('recurring.inactive', inactive)}

        {empty && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="recurring-empty">
            <Icon name="autorenew" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('recurring.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('recurring.emptyBody')}</p>
          </div>
        )}
      </div>

      <RecurringFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
    </div>
  );
}
