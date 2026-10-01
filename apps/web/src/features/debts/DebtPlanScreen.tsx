import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import { LOCALES, useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n/en';
import { useData } from '@/app/data';
import { useLoanStatuses } from '@/application/debts';
import { localToday } from '@/application/recurring';
import { logActivity } from '@/application/activity';
import { STRATEGIES, STRESS_LEVELS, compareStrategies, extraLadder, monthAfter, simulateBaseline, simulatePlan, toPlanDebts } from '@/domain/debtPlan';
import type { DebtOutcome, DebtStress, PayoffStrategy, PlanDebt, PlanResult } from '@/domain/debtPlan';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { LoanTile } from './DebtsScreen';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Chip, HeroCard, Tile } from '@/ui/primitives';
import { MultiLine } from '@/ui/charts/MultiLine';

/** what the person tried last time, per space and device — a convenience, never the truth */
interface PlanInputs {
  strategy: PayoffStrategy;
  extraCents: number;
  lumpCents: number;
}
const DEFAULT_INPUTS: PlanInputs = { strategy: 'avalanche', extraCents: 0, lumpCents: 0 };
const inputsKey = (spaceId: string) => `munni_debtplan_${spaceId}`;
function readInputs(spaceId: string): PlanInputs {
  try {
    const raw = localStorage.getItem(inputsKey(spaceId));
    if (!raw) return DEFAULT_INPUTS;
    const parsed = JSON.parse(raw) as Partial<PlanInputs>;
    return {
      strategy: STRATEGIES.includes(parsed.strategy as PayoffStrategy) ? (parsed.strategy as PayoffStrategy) : 'avalanche',
      extraCents: Number.isFinite(parsed.extraCents) ? Math.max(0, Math.round(parsed.extraCents as number)) : 0,
      lumpCents: Number.isFinite(parsed.lumpCents) ? Math.max(0, Math.round(parsed.lumpCents as number)) : 0,
    };
  } catch {
    return DEFAULT_INPUTS;
  }
}
function writeInputs(spaceId: string, inputs: PlanInputs) {
  try {
    localStorage.setItem(inputsKey(spaceId), JSON.stringify(inputs));
  } catch {
    // storage blocked: the inputs live for this visit only
  }
}

/** the quick extras under the slider, in cents */
const EXTRA_CHIPS = [2_500, 5_000, 10_000, 25_000];
/** the ladder: a little more than now */
const LADDER = [2_500, 5_000, 10_000, 25_000];
const STRATEGY_COPY: Record<PayoffStrategy, { name: TranslationKey; sub: TranslationKey }> = {
  avalanche: { name: 'debtplan.avalanche', sub: 'debtplan.avalancheSub' },
  snowball: { name: 'debtplan.snowball', sub: 'debtplan.snowballSub' },
  tsunami: { name: 'debtplan.tsunami', sub: 'debtplan.tsunamiSub' },
};
const STRESS_COPY: Record<DebtStress, TranslationKey> = {
  1: 'debtplan.stress1',
  2: 'debtplan.stress2',
  3: 'debtplan.stress3',
  4: 'debtplan.stress4',
  5: 'debtplan.stress5',
};

/** the chart stays light: at most ~120 points per line, both lines on the same month grid */
function sampled(values: readonly number[], step: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i += step) out.push(values[i]);
  const last = values.at(-1);
  if (last !== undefined && (values.length - 1) % step !== 0) out.push(last);
  return out;
}

const parseEuros = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

/** The payoff planner (#413): which order, how much extra, and what that buys — all from the loans as they stand. */
export function DebtPlanScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, repo, spaceId } = useData();
  const statuses = useLoanStatuses();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const { fmt } = useDisplayMoney();
  const money = (cents: number) => fmt(cents, currency);
  const today = localToday();
  const [inputs, setInputs] = useState<PlanInputs>(() => readInputs(spaceId));
  const [extraText, setExtraText] = useState(() => (inputs.extraCents ? (inputs.extraCents / 100).toFixed(0) : ''));
  const [lumpText, setLumpText] = useState(() => (inputs.lumpCents ? (inputs.lumpCents / 100).toFixed(0) : ''));
  const update = (patch: Partial<PlanInputs>) => {
    setInputs((prev) => {
      const next = { ...prev, ...patch };
      writeInputs(spaceId, next);
      return next;
    });
  };
  const setExtra = (cents: number) => {
    update({ extraCents: cents });
    setExtraText(cents ? String(Math.round(cents / 100)) : '');
  };

  const debts: PlanDebt[] = useMemo(() => toPlanDebts(statuses ?? []), [statuses]);
  const plan = useMemo(
    () => simulatePlan(debts, { strategy: inputs.strategy, extraMonthlyCents: inputs.extraCents, lumpSumCents: inputs.lumpCents }),
    [debts, inputs],
  );
  const baseline = useMemo(() => simulateBaseline(debts), [debts]);
  const compared = useMemo(
    () => compareStrategies(debts, { extraMonthlyCents: inputs.extraCents, lumpSumCents: inputs.lumpCents }),
    [debts, inputs.extraCents, inputs.lumpCents],
  );
  const ladder = useMemo(
    () => extraLadder(debts, { strategy: inputs.strategy, extraMonthlyCents: inputs.extraCents, lumpSumCents: inputs.lumpCents }, LADDER),
    [debts, inputs],
  );

  const fmtMonth = (months: number) =>
    new Date(`${monthAfter(today, months)}-01`).toLocaleDateString(LOCALES[lang], { month: 'short', year: 'numeric' });
  const freeLabel = (r: PlanResult) => (r.months === null ? t('debtplan.freeNever') : t('debtplan.freeIn', { date: fmtMonth(r.months) }));

  const monthsSaved = plan.months !== null && baseline.months !== null ? baseline.months - plan.months : null;
  const interestSaved = baseline.totalInterestCents - plan.totalInterestCents;
  let vsText: string;
  if (monthsSaved === null) vsText = t('debtplan.vsMinimumUnknown');
  else if (monthsSaved <= 0 && interestSaved <= 0) vsText = t('debtplan.vsMinimumSame');
  else vsText = t('debtplan.vsMinimum', { months: monthsSaved, interest: money(Math.max(0, interestSaved)) });
  /** what one ladder step buys against the plan as it stands */
  const ladderGain = (earlier: number | null, less: number, months: number | null): string => {
    if (earlier === null) return months === null ? t('debtplan.ladderNone') : t('debtplan.ladderUnstuck', { date: fmtMonth(months) });
    if (earlier <= 0 && less <= 0) return t('debtplan.ladderNone');
    return t('debtplan.ladderGain', { months: earlier, interest: money(Math.max(0, less)) });
  };
  /** when a debt ends in this plan, or why it does not */
  const endLabel = (outcome: DebtOutcome): string => {
    if (outcome.stuck) return t('debtplan.neverPaid');
    if (outcome.paidOffMonth === null) return t('debtplan.freeNever');
    return t('debtplan.paidOff', { date: fmtMonth(outcome.paidOffMonth) });
  };
  const sliderMax = Math.max(100_000, plan.minimumsCents * 2);
  const step = Math.max(1, Math.ceil(Math.max(plan.balances.length, baseline.balances.length) / 120));
  const planLine = sampled(plan.balances, step);
  const baseLine = sampled(baseline.balances, step);
  const points = Math.max(planLine.length, baseLine.length);
  const labels = Array.from({ length: points }, (_, i) => {
    const month = i * step;
    return month % 12 === 0 ? String(Number(monthAfter(today, month).slice(0, 4))) : '';
  });

  const setStress = (debtId: string, value: DebtStress) => {
    const account = statuses?.find((s) => s.account.id === debtId)?.account;
    if (!account) return;
    void repo.upsert('account', account.spaceId, account.id, { debtStress: account.debtStress === value ? undefined : value });
    void logActivity(store, repo, account.spaceId, 'accountEdit', account.name);
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-debtplan">
      <AppBar
        title={t('debtplan.title')}
        leading={
          <IconButton label={t('action.back')} testId="debtplan-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={<HelpButton tourId="debts" />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {statuses && debts.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="debtplan-empty">
            <Icon name="hand-coin-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[13px] text-ink-3">{t('debtplan.empty')}</p>
            <button className="m-tap text-[13px] font-semibold text-accent-deep" onClick={() => void navigate({ to: '/debts' })}>
              {t('debts.title')}
            </button>
          </div>
        )}
        {debts.length > 0 && (
          <>
            <HeroCard
              testId="debtplan-hero"
              tile={<Tile icon="chart-timeline-variant" tone="accent" size={48} />}
              number={<span data-testid="debtplan-free">{freeLabel(plan)}</span>}
              sub={
                plan.months === null
                  ? t('debtplan.stuckHint')
                  : t('debtplan.monthsInterest', { months: plan.months, interest: money(plan.totalInterestCents) })
              }
              meta={
                <span className="text-[12px] text-ink-3" data-testid="debtplan-vs">
                  {vsText}
                </span>
              }
            />

            {/* the order */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-strategies">
              <div className="m-cap">{t('debtplan.strategy')}</div>
              <div className="mt-2 flex flex-wrap gap-2">
                {STRATEGIES.map((s) => (
                  <Chip key={s} selected={inputs.strategy === s} onClick={() => update({ strategy: s })} testId={`debtplan-strategy-${s}`}>
                    {t(STRATEGY_COPY[s].name)}
                  </Chip>
                ))}
              </div>
              <p className="mt-2 text-[12px] text-ink-3">{t(STRATEGY_COPY[inputs.strategy].sub)}</p>
              <div className="mt-3 divide-y divide-line-2 border-t border-line-2 pt-1" data-testid="debtplan-compare">
                {STRATEGIES.map((s) => (
                  <div key={s} className="flex items-baseline justify-between gap-2 py-1.5 text-[12px]" data-testid={`debtplan-compare-${s}`}>
                    <span className={inputs.strategy === s ? 'font-semibold text-ink' : 'text-ink-2'}>{t(STRATEGY_COPY[s].name)}</span>
                    <span className="m-num text-ink-3">
                      {compared[s].months === null ? t('debtplan.freeNever') : t('debtplan.compareFree', { date: fmtMonth(compared[s].months as number) })}
                      {' · '}
                      {money(compared[s].totalInterestCents)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* the extra */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-extra-card">
              <div className="flex items-end gap-3">
                <label className="min-w-0 flex-1 text-[12px] text-ink-3">
                  {t('debtplan.extra')}
                  <input
                    data-testid="debtplan-extra"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="5"
                    value={extraText}
                    onChange={(e) => {
                      setExtraText(e.target.value);
                      update({ extraCents: parseEuros(e.target.value) });
                    }}
                    placeholder="0"
                    className="mt-1 h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
                  />
                </label>
                <label className="min-w-0 flex-1 text-[12px] text-ink-3">
                  {t('debtplan.lump')}
                  <input
                    data-testid="debtplan-lump"
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="50"
                    value={lumpText}
                    onChange={(e) => {
                      setLumpText(e.target.value);
                      update({ lumpCents: parseEuros(e.target.value) });
                    }}
                    placeholder="0"
                    className="mt-1 h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
                  />
                </label>
              </div>
              <input
                data-testid="debtplan-extra-slider"
                type="range"
                min={0}
                max={sliderMax}
                step={500}
                value={Math.min(inputs.extraCents, sliderMax)}
                onChange={(e) => setExtra(Number(e.target.value))}
                aria-label={t('debtplan.extra')}
                className="mt-3 w-full accent-[var(--m-accent)]"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                {EXTRA_CHIPS.map((cents) => (
                  <Chip key={cents} selected={inputs.extraCents === cents} onClick={() => setExtra(cents)} testId={`debtplan-extra-chip-${cents}`}>
                    +{money(cents)}
                  </Chip>
                ))}
              </div>
              <p className="mt-2 text-[11px] text-ink-4">
                {t('debtplan.minimums', { amount: money(plan.minimumsCents) })} · {t('debtplan.budget', { amount: money(plan.minimumsCents + inputs.extraCents) })}
              </p>
            </div>

            {/* the chart */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4">
              <div className="flex items-center gap-3 text-[11px] text-ink-3">
                <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded bg-accent" /> {t('debtplan.chartPlan')}</span>
                <span className="flex items-center gap-1.5"><span className="inline-block h-0.5 w-4 rounded border-t border-dashed border-ink-4" /> {t('debtplan.chartBaseline')}</span>
              </div>
              <div className="mt-2">
                <MultiLine
                  testId="debtplan-chart"
                  height={160}
                  labels={labels}
                  series={[
                    { values: baseLine, color: 'var(--m-ink-4)', dashed: true },
                    { values: planLine, color: 'var(--m-accent)' },
                  ]}
                />
              </div>
            </div>

            {/* what more buys */}
            <div className="mt-3 rounded-card border border-line bg-surface p-4" data-testid="debtplan-ladder">
              <div className="m-cap">{t('debtplan.ladder')}</div>
              <div className="mt-1 divide-y divide-line-2">
                {ladder.map((row) => {
                  const earlier = plan.months !== null && row.months !== null ? plan.months - row.months : null;
                  const less = plan.totalInterestCents - row.totalInterestCents;
                  const gain = ladderGain(earlier, less, row.months);
                  return (
                    <button
                      key={row.moreCents}
                      data-testid={`debtplan-ladder-${row.moreCents}`}
                      onClick={() => setExtra(inputs.extraCents + row.moreCents)}
                      className="m-tap flex w-full items-baseline justify-between gap-3 bg-transparent py-2 text-left"
                    >
                      <span className="m-num text-[13px] font-semibold text-ink">{t('debtplan.ladderRow', { amount: money(row.moreCents) })}</span>
                      <span className="text-right text-[12px] text-ink-3">{gain}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* the order, debt by debt */}
            <div className="mt-3" data-testid="debtplan-order">
              <div className="m-cap mb-2">{t('debtplan.order')}</div>
              {inputs.strategy === 'tsunami' && <p className="mb-2 text-[12px] text-ink-3">{t('debtplan.stressHint')}</p>}
              <div className="flex flex-col gap-2">
                {plan.debts.map((outcome) => {
                  const status = statuses?.find((s) => s.account.id === outcome.id);
                  const planDebt = debts.find((d) => d.id === outcome.id);
                  if (!status || !planDebt) return null;
                  const { account } = status;
                  return (
                    <div key={outcome.id} className="rounded-card border border-line bg-surface p-3" data-testid={`debtplan-order-${outcome.id}`}>
                      <div className="flex items-center gap-3">
                        <span className="m-num w-5 shrink-0 text-center text-[12px] font-semibold text-ink-4">{outcome.order}</span>
                        <LoanTile account={account} />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-baseline justify-between gap-2">
                            <span className="truncate text-[14px] font-semibold text-ink">{account.name}</span>
                            <span className="m-num shrink-0 text-[13px] text-ink">{money(planDebt.balanceCents)}</span>
                          </span>
                          <span className="block text-[11px] text-ink-4">
                            {planDebt.aprKnown ? `${planDebt.aprPct}% ${t('debts.aprShort')}` : t('debtplan.noRate')}
                            {' · '}
                            {endLabel(outcome)}
                          </span>
                        </span>
                      </div>
                      {inputs.strategy === 'tsunami' && (
                        <div className="mt-2 flex items-center gap-1.5">
                          <span className="mr-1 text-[11px] text-ink-4">{t('debtplan.stress')}</span>
                          {STRESS_LEVELS.map((level) => (
                            <Chip
                              key={level}
                              selected={account.debtStress === level}
                              onClick={() => setStress(account.id, level)}
                              testId={`debtplan-stress-${account.id}-${level}`}
                              className="px-2.5"
                            >
                              {level === 1 || level === 5 ? t(STRESS_COPY[level]) : String(level)}
                            </Chip>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
