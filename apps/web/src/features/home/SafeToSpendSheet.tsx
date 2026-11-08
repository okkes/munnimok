import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
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
import { Button } from '@/ui/Button';
import { FormBlockerNote } from '@/ui/FormBlockerNote';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TickBox, enterToggles } from '@/ui/TickBox';

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
 * Safe to spend's breakdown (#541): nothing in the number is magic — the
 * accounts summed, every due that comes off with its date, the plan's
 * set-asides as switches, and what is left. The accounts and the switches
 * are space settings; every member reads the same number.
 */
export function SafeToSpendSheet({
  open,
  onOpenChange,
  forecast,
  accounts,
  space,
  currency,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  forecast: SafeToSpend;
  /** every account the space sees — the picker offers the ones money is spent from */
  accounts: readonly SpaceAccount[];
  space: SpaceRow | undefined;
  /** the ledger currency the forecast was summed in */
  currency: string;
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const ops = useSafeToSpendOps();
  // #505: which accounts and set-asides count is the space's choice — a reader reads it
  const canEdit = useCanEdit();
  const { fmt, fmtSensitive, hideSensitive } = useDisplayMoney();
  const [pickOpen, setPickOpen] = useState(false);
  const fmtDate = (iso: string) => parseLocalDate(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' });
  const end = fmtDate(forecast.period.end);
  const empty = forecast.accounts.length === 0;
  const safe = (cents: number) => (empty ? '—' : fmtSensitive(cents, currency));

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('cashflow.title')} size="tall">
        <div className="flex flex-col pt-1" data-testid="cashflow-breakdown">
          <div className="pb-2 text-center">
            <div className="m-num text-[30px] font-semibold text-ink" data-testid="cashflow-headline">
              {safe(forecast.cents)}
            </div>
            {!empty && (
              <div className="text-[12px] text-ink-3">{t('cashflow.untilEnd', { date: end, perDay: fmtSensitive(forecast.perDayCents, currency) })}</div>
            )}
          </div>
          {/* the proportions would give the hidden balance away next to the visible dues (#530) */}
          {!empty && !hideSensitive && <ShareBar forecast={forecast} />}

          <SectionHead
            title={t('cashflow.accounts')}
            sub={t('cashflow.accountsSub')}
            amount={safe(forecast.balanceCents)}
            amountTestId="cashflow-accounts-total"
            action={
              canEdit && (
                <button
                  type="button"
                  data-testid="cashflow-accounts-change"
                  onClick={() => setPickOpen(true)}
                  className="m-tap shrink-0 border-none bg-transparent px-1 text-[12px] font-semibold text-accent-deep"
                >
                  {t('cashflow.accountsChange')}
                </button>
              )
            }
          />
          {forecast.accounts.map((account) => (
            <div key={account.id} className="flex items-baseline justify-between gap-3 py-1 pl-4 text-[13px]" data-testid={`cashflow-account-${account.id}`}>
              <span className="min-w-0 flex-1 truncate text-ink-3">{account.name}</span>
              <span className="m-num text-ink-3">{fmtSensitive(account.balanceCents, currency)}</span>
            </div>
          ))}
          {empty && canEdit && (
            <Button variant="outline" size="sm" className="mt-2 self-start" data-testid="cashflow-accounts-pick" onClick={() => setPickOpen(true)}>
              {t('cashflow.accountsPick')}
            </Button>
          )}

          <SectionHead
            title={t('cashflow.due', { date: end })}
            sub={t('cashflow.dueSub')}
            dot={DUES_COLOR}
            amount={fmt(-forecast.dueCents, currency, { sign: true })}
            amountTestId="cashflow-dues-total"
          />
          {forecast.dues.map((due) => (
            <DueRow key={`${due.kind}-${due.id}`} due={due} currency={currency} fmtDate={fmtDate} />
          ))}
          {forecast.dues.length === 0 && (
            <p className="py-1 pl-4 text-[13px] text-ink-4" data-testid="cashflow-dues-none">
              {t('cashflow.dueNone')}
            </p>
          )}

          <SectionHead
            title={t('cashflow.setAside')}
            sub={t('cashflow.setAsideSub')}
            dot={SET_ASIDE_COLOR}
            amount={fmt(-forecast.setAsideCents, currency, { sign: true })}
            amountTestId="cashflow-setasides-total"
          />
          {forecast.setAsides.map((line) => (
            <div key={line.kind} className="flex items-center gap-3 py-1.5 pl-4 text-[13px]" inert={canEdit ? undefined : true}>
              <span className="min-w-0 flex-1 truncate text-ink-2">{t(SET_ASIDE_LABEL[line.kind])}</span>
              <span className="m-num text-ink-3">{fmt(line.cents, currency)}</span>
              <Switch
                on={line.picked}
                label={t(SET_ASIDE_LABEL[line.kind])}
                testId={`cashflow-setaside-${line.kind}`}
                onToggle={() => void ops.toggleSetAside(line.kind)}
              />
            </div>
          ))}
          {forecast.setAsides.length === 0 && (
            <div className="flex flex-col items-start gap-2 py-1 pl-4" data-testid="cashflow-noplan">
              <p className="text-[13px] leading-snug text-ink-4">{t('cashflow.setAsideNoPlan')}</p>
              <Button variant="outline" size="sm" data-testid="cashflow-noplan-open" onClick={() => void navigate({ to: '/planning' })}>
                {t('cashflow.openPlanning')}
              </Button>
            </div>
          )}

          <div className="mt-3 flex items-baseline justify-between border-t border-line pt-3 text-[15px]">
            <span className="flex items-center gap-2 font-medium text-ink">
              <span className="h-2 w-2 rounded-full" style={{ background: SAFE_COLOR }} />
              {t('cashflow.safeUntil', { date: end })}
            </span>
            <span className="m-num font-semibold text-ink" data-testid="cashflow-total">
              {safe(forecast.cents)}
            </span>
          </div>
        </div>
      </Sheet>
      {/* a sibling, never nested (#241) */}
      <SpendAccountsSheet open={pickOpen} onOpenChange={setPickOpen} accounts={accounts} space={space} onSave={ops.setAccounts} />
    </>
  );
}

/** how the balance divides into what is due, what is kept aside and what is free */
function ShareBar({ forecast }: Readonly<{ forecast: SafeToSpend }>) {
  const free = Math.max(0, forecast.cents);
  const total = Math.max(1, forecast.dueCents + forecast.setAsideCents + free);
  const pct = (part: number) => `${(part / total) * 100}%`;
  return (
    <div className="flex h-3 w-full gap-px overflow-hidden rounded-full bg-bg-2" data-testid="cashflow-bar" aria-hidden="true">
      {forecast.dueCents > 0 && <span style={{ width: pct(forecast.dueCents), background: DUES_COLOR }} />}
      {forecast.setAsideCents > 0 && <span style={{ width: pct(forecast.setAsideCents), background: SET_ASIDE_COLOR }} />}
      {free > 0 && <span style={{ width: pct(free), background: SAFE_COLOR }} />}
    </div>
  );
}

function SectionHead({
  title,
  sub,
  amount,
  amountTestId,
  dot,
  action,
}: Readonly<{ title: string; sub: string; amount: string; amountTestId: string; dot?: string; action?: ReactNode }>) {
  return (
    <div className="mt-3 flex items-start gap-2 border-t border-line-2 pt-3">
      {dot && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full" style={{ background: dot }} />}
      <span className="min-w-0 flex-1">
        <span className="block text-[14px] font-medium text-ink">{title}</span>
        <span className="block text-[11px] leading-snug text-ink-4">{sub}</span>
      </span>
      {action}
      <span className="m-num shrink-0 text-[14px] text-ink-2" data-testid={amountTestId}>
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
    <button
      type="button"
      data-testid={`cashflow-due-${due.id}`}
      onClick={open}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent py-1.5 pl-4 text-left text-[13px]"
    >
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ink-2">{due.name}</span>
        <span className="block truncate text-[11px] text-ink-4">
          {due.dates.length > 1 ? `${why} · ${t('cashflow.dueTimes', { n: due.dates.length })}` : why}
        </span>
      </span>
      <span className="m-num text-ink-3">{fmt(-due.cents, currency, { sign: true })}</span>
      <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
    </button>
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
