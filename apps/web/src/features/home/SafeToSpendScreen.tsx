import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { parseLocalDate } from '@/application/planningModel';
import { useSafeToSpendOps } from '@/application/safeToSpend';
import { useCanEdit } from '@/app/useCanEdit';
import type { SpaceAccount } from '@/db/joined';
import type { SpaceRow, SpendSetAside } from '@/db/types';
import { isDefaultSpendPick, isSpendAccount, isSpendCandidate } from '@/domain/safeToSpend';
import type { SafeToSpend, SpendDue } from '@/domain/safeToSpend';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { LOCALES, useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { HeroCard, Row, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { TickBox, enterToggles } from '@/ui/TickBox';
import { safeToSpendColor, useSafeToSpend } from './useSafeToSpend';

/** the planner's own names for what it holds (#541: "segments from the planner tool") */
const SET_ASIDE_LABEL: Record<SpendSetAside, TranslationKey> = {
  goals: 'plan.segment.goals',
  events: 'plan.segment.events',
  expenses: 'plan.segment.expenses',
  budgets: 'plan.segment.budgets',
  ahead: 'plan.aheadTitle',
};

const DUES_COLOR = 'var(--m-warning)';
const SET_ASIDE_COLOR = 'var(--m-info)';
const SAFE_COLOR = 'var(--m-accent)';

/**
 * Safe to spend's own screen (#541, user 2026-11-16: "a dedicated screen",
 * the figure said once): nothing in the number is magic — the accounts
 * summed, every due that comes off with its date, the plan's set-asides as
 * switches. The accounts and the switches are space settings; every member
 * reads the same number.
 */
export function SafeToSpendScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const router = useRouter();
  const ops = useSafeToSpendOps();
  // #505: which accounts and set-asides count is the space's choice — a reader reads it
  const canEdit = useCanEdit();
  const { fmt, fmtSensitive, hideSensitive } = useDisplayMoney();
  const { forecast, accounts, space, currency } = useSafeToSpend();
  const [pickOpen, setPickOpen] = useState(false);
  const fmtDate = (iso: string) => parseLocalDate(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-safe-to-spend">
      <AppBar
        title={t('cashflow.title')}
        leading={
          <IconButton label={t('action.back')} testId="cashflow-back" onClick={() => router.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {forecast && (
          <Breakdown
            forecast={forecast}
            currency={currency}
            fmtDate={fmtDate}
            safe={(cents) => (forecast.accounts.length === 0 ? '—' : fmtSensitive(cents, currency))}
            off={(cents) => fmt(-cents, currency, { sign: true })}
            hidden={hideSensitive}
            canEdit={canEdit}
            onPick={() => setPickOpen(true)}
            onToggle={(kind) => void ops.toggleSetAside(kind)}
            onPlan={() => void navigate({ to: '/planning' })}
          />
        )}
      </div>
      {/* a sibling, never nested (#241) */}
      <SpendAccountsSheet open={pickOpen} onOpenChange={setPickOpen} accounts={accounts ?? []} space={space} onSave={ops.setAccounts} />
    </div>
  );
}

function Breakdown({
  forecast,
  currency,
  fmtDate,
  safe,
  off,
  hidden,
  canEdit,
  onPick,
  onToggle,
  onPlan,
}: Readonly<{
  forecast: SafeToSpend;
  currency: string;
  fmtDate: (iso: string) => string;
  /** a balance-built figure: stars while the device hides them, a dash without accounts */
  safe: (cents: number) => string;
  /** an amount that comes off */
  off: (cents: number) => string;
  hidden: boolean;
  canEdit: boolean;
  onPick: () => void;
  onToggle: (kind: SpendSetAside) => void;
  onPlan: () => void;
}>) {
  const { t } = useLang();
  const { fmt, fmtSensitive } = useDisplayMoney();
  const end = fmtDate(forecast.period.end);
  const empty = forecast.accounts.length === 0;
  const color = safeToSpendColor(forecast, hidden);
  return (
    <div className="flex flex-col pt-1" data-testid="cashflow-breakdown">
      <HeroCard
        testId="cashflow-hero"
        tile={<Tile size={48} icon="calendar-arrow-right" bg={`color-mix(in srgb, ${color} 14%, transparent)`} color={color} />}
        number={
          <span style={{ color }} data-testid="cashflow-headline">
            {safe(forecast.cents)}
          </span>
        }
        sub={empty ? t('cashflow.accountsPick') : t('cashflow.untilEnd', { date: end, perDay: fmtSensitive(forecast.perDayCents, currency) })}
        // the proportions would give the hidden balance away next to the visible dues (#530)
        progress={!empty && !hidden ? <ShareBar forecast={forecast} /> : undefined}
        meta={
          !empty && !hidden ? (
            <>
              <Legend color={DUES_COLOR} text={t('cashflow.legendDue')} />
              <Legend color={SET_ASIDE_COLOR} text={t('cashflow.legendAside')} />
              <Legend color={SAFE_COLOR} text={t('cashflow.legendFree')} />
            </>
          ) : undefined
        }
      />

      <Section
        caption={t('cashflow.accounts')}
        hint={t('cashflow.accountsSub')}
        action={
          canEdit &&
          !empty && (
            <button
              type="button"
              data-testid="cashflow-accounts-change"
              onClick={onPick}
              className="m-tap border-none bg-transparent p-0 text-[12px] font-semibold text-accent-deep"
            >
              {t('cashflow.accountsChange')}
            </button>
          )
        }
      >
        {forecast.accounts.map((account) => (
          <Row
            key={account.id}
            kind="data"
            testId={`cashflow-account-${account.id}`}
            title={account.name}
            trailing={<span className="m-num text-[13px] text-ink-2">{fmtSensitive(account.balanceCents, currency)}</span>}
          />
        ))}
        {empty && (
          <div className="flex flex-col items-start gap-2 px-4 py-3">
            <p className="text-[13px] leading-snug text-ink-3">{t('cashflow.pickHint')}</p>
            {canEdit && (
              <Button variant="outline" size="sm" data-testid="cashflow-accounts-pick" onClick={onPick}>
                {t('cashflow.accountsPick')}
              </Button>
            )}
          </div>
        )}
        {!empty && <SumRow label={t('cashflow.sumAccounts')} amount={safe(forecast.balanceCents)} testId="cashflow-accounts-total" />}
      </Section>

      <Section caption={t('cashflow.due', { date: end })} hint={t('cashflow.dueSub')} dot={DUES_COLOR}>
        {forecast.dues.map((due) => (
          <DueRow key={`${due.kind}-${due.id}`} due={due} currency={currency} fmtDate={fmtDate} />
        ))}
        {forecast.dues.length === 0 && <Row kind="data" testId="cashflow-dues-none" title={<span className="font-normal text-ink-3">{t('cashflow.dueNone')}</span>} />}
        {forecast.dues.length > 0 && <SumRow label={t('cashflow.sumOff')} amount={off(forecast.dueCents)} testId="cashflow-dues-total" />}
      </Section>

      <Section caption={t('cashflow.setAside')} hint={forecast.setAsides.length > 0 ? t('cashflow.setAsideSub') : undefined} dot={SET_ASIDE_COLOR}>
        {forecast.setAsides.map((line) => (
          // the divider sits on the wrapper: the row inside is its only child, and an only child draws none
          <div key={line.kind} className="border-b border-line-2" inert={canEdit ? undefined : true}>
            <Row
              kind="data"
              title={t(SET_ASIDE_LABEL[line.kind])}
              trailing={
                <>
                  <span className="m-num text-[13px] text-ink-2">{fmt(line.cents, currency)}</span>
                  <Switch on={line.picked} label={t(SET_ASIDE_LABEL[line.kind])} testId={`cashflow-setaside-${line.kind}`} onToggle={() => onToggle(line.kind)} />
                </>
              }
            />
          </div>
        ))}
        {forecast.setAsides.length === 0 && (
          <div className="flex flex-col items-start gap-2 px-4 py-3" data-testid="cashflow-noplan">
            <p className="text-[13px] leading-snug text-ink-3">{t('cashflow.setAsideNoPlan')}</p>
            <Button variant="outline" size="sm" data-testid="cashflow-noplan-open" onClick={onPlan}>
              {t('cashflow.openPlanning')}
            </Button>
          </div>
        )}
        {forecast.setAsides.length > 0 && <SumRow label={t('cashflow.sumOff')} amount={off(forecast.setAsideCents)} testId="cashflow-setasides-total" />}
      </Section>
    </div>
  );
}

/** how the balance divides into what is due, what is kept aside and what is free */
function ShareBar({ forecast }: Readonly<{ forecast: SafeToSpend }>) {
  const free = Math.max(0, forecast.cents);
  const total = Math.max(1, forecast.dueCents + forecast.setAsideCents + free);
  const pct = (part: number) => `${(part / total) * 100}%`;
  return (
    <div className="flex h-2.5 w-full gap-px overflow-hidden rounded-full bg-bg-2" data-testid="cashflow-bar" aria-hidden="true">
      {forecast.dueCents > 0 && <span style={{ width: pct(forecast.dueCents), background: DUES_COLOR }} />}
      {forecast.setAsideCents > 0 && <span style={{ width: pct(forecast.setAsideCents), background: SET_ASIDE_COLOR }} />}
      {free > 0 && <span style={{ width: pct(free), background: SAFE_COLOR }} />}
    </div>
  );
}

function Legend({ color, text }: Readonly<{ color: string; text: string }>) {
  return (
    <span className="flex items-center gap-1.5 text-[11px]">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {text}
    </span>
  );
}

/** a captioned card, the way every list screen groups its rows; the dot ties a card to its share of the bar */
function Section({ caption, hint, dot, action, children }: Readonly<{ caption: string; hint?: string; dot?: string; action?: ReactNode; children: ReactNode }>) {
  return (
    <>
      <div className="m-cap mt-5 mb-1 flex items-center gap-2 px-1">
        {dot && <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}
        <span className="min-w-0 flex-1 truncate">{caption}</span>
        {action}
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">{children}</div>
      {hint && <p className="mt-1 px-1 text-[11px] leading-snug text-ink-4">{hint}</p>}
    </>
  );
}

/** a card's own total */
function SumRow({ label, amount, testId }: Readonly<{ label: string; amount: string; testId: string }>) {
  return (
    <div className="flex items-baseline justify-between gap-3 bg-bg-2 px-4 py-2.5 text-[13px]">
      <span className="font-medium text-ink-2">{label}</span>
      <span className="m-num font-semibold text-ink" data-testid={testId}>
        {amount}
      </span>
    </div>
  );
}

/** one due and why it comes off: what it is and when — a tap opens its own screen */
function DueRow({ due, currency, fmtDate }: Readonly<{ due: SpendDue; currency: string; fmtDate: (iso: string) => string }>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const { fmt } = useDisplayMoney();
  const open = () => {
    if (due.kind === 'loan') void navigate({ to: '/debts/$debtId', params: { debtId: due.id } });
    else void navigate({ to: '/recurring/$recId', params: { recId: due.id } });
  };
  const why = t(due.kind === 'loan' ? 'cashflow.dueLoan' : 'cashflow.dueRecurring', { date: fmtDate(due.dates[0]) });
  return (
    <Row
      kind="data"
      testId={`cashflow-due-${due.id}`}
      title={due.name}
      sub={due.dates.length > 1 ? `${why} · ${t('cashflow.dueTimes', { n: due.dates.length })}` : why}
      trailing={<span className="m-num text-[13px] text-ink-2">{fmt(-due.cents, currency, { sign: true })}</span>}
      chevron
      onClick={open}
    />
  );
}

/** the house switch at row density */
function Switch({ on, label, testId, onToggle }: Readonly<{ on: boolean; label: string; testId: string; onToggle: () => void }>) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      data-testid={testId}
      onClick={onToggle}
      className={`flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-none p-0.5 transition-colors ${on ? 'justify-end bg-accent' : 'justify-start bg-bg-2'}`}
    >
      <span className="h-4 w-4 rounded-full bg-surface shadow" />
    </button>
  );
}

/** the accounts safe to spend sums — one at least; the default pick stores nothing, so new checking accounts join by themselves */
function SpendAccountsSheet({
  open,
  onOpenChange,
  accounts,
  space,
  onSave,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: readonly SpaceAccount[];
  space: SpaceRow | undefined;
  onSave: (ids: readonly string[] | null) => Promise<void>;
}>) {
  const { t } = useLang();
  const { fmtSensitive } = useDisplayMoney();
  const candidates = accounts.filter(isSpendCandidate);
  const pickedKey = candidates
    .filter((a) => isSpendAccount(a, space))
    .map((a) => a.id)
    .sort((a, b) => a.localeCompare(b))
    .join(',');
  const [ticks, setTicks] = useState<ReadonlySet<string>>(new Set());
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTicks(new Set(pickedKey ? pickedKey.split(',') : []));
    setAttempted(false);
  }, [open, pickedKey]);
  const toggle = (id: string) =>
    setTicks((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const save = async () => {
    if (ticks.size === 0) {
      setAttempted(true);
      return;
    }
    await onSave(isDefaultSpendPick(ticks, accounts) ? null : [...ticks]);
    onOpenChange(false);
  };
  return (
    <Sheet
      open={open}
      onOpenChange={onOpenChange}
      title={t('cashflow.pickTitle')}
      size="tall"
      footer={
        <Button className="w-full" data-testid="cashflow-pick-save" onClick={() => void save()}>
          {t('action.save')}
        </Button>
      }
    >
      <div className="flex flex-col gap-3" data-testid="cashflow-pick">
        <p className="text-[12px] text-ink-3">{t('cashflow.pickHint')}</p>
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          {candidates.map((account) => {
            const on = ticks.has(account.id);
            // the row labels a native checkbox that wears the house tick; the row wears its focus ring (m-focus-card)
            return (
              <label
                key={account.id}
                className="m-tap m-focus-card relative flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
              >
                <input
                  type="checkbox"
                  data-testid={`cashflow-pick-${account.id}`}
                  data-quiet-focus
                  checked={on}
                  onChange={() => toggle(account.id)}
                  onKeyDown={enterToggles}
                  className="sr-only"
                />
                <TickBox state={on ? 'checked' : 'off'} />
                <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{account.name}</span>
                <span className="m-num text-[13px] text-ink-2">{fmtSensitive(account.balanceCents, account.currency)}</span>
              </label>
            );
          })}
        </div>
        <FormBlockerNote show={attempted && ticks.size === 0} text={t('cashflow.pickNone')} testId="cashflow-pick-blocker" />
      </div>
    </Sheet>
  );
}
