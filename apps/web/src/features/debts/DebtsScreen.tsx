import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useDebtOps, useDebtStatuses } from '@/application/debts';
import type { DebtStatus } from '@/application/debts';
import { logActivity } from '@/application/activity';
import { manualBalanceDate } from '@/features/accounts/accountTypes';
import { useSpaceAccounts } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { projectPayoff } from '@/domain/debts';
import type { DebtRow } from '@/db/types';
import { parseCents } from '@/lib/money';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { ProgressBar, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

export const DEBT_ICONS = ['home-percent-outline', 'credit-card-outline', 'car-outline', 'school-outline', 'hand-coin-outline', 'account-cash-outline'] as const;
const LIABILITY_TYPES = new Set(['credit', 'mortgage', 'loan']);
/** select sentinel: quick-create a loan account named after the debt */
const NEW_ACCOUNT = '__new__';

/** create/edit sheet. A debt is ALWAYS backed by a loan account (user
 *  rule 2026-07-28): the account's balance is the remaining truth and
 *  only transactions move it — a missing account quick-creates here. */
export function DebtFormSheet({ initial, onClose }: Readonly<{ initial: DebtRow | 'new' | null; onClose: () => void }>) {
  const { t } = useLang();
  const { fmt } = useDisplayMoney();
  const ops = useDebtOps();
  const { store, repo, spaceId } = useData();
  const accounts = useSpaceAccounts();
  const editing = initial !== 'new' && initial !== null ? initial : null;
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(DEBT_ICONS[0]);
  const [accountId, setAccountId] = useState('');
  const [original, setOriginal] = useState('');
  const [remaining, setRemaining] = useState('');
  const [apr, setApr] = useState('');
  const [payment, setPayment] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  // seed keyed on the record's ID, never object identity (the iOS
  // reseed class: re-emitted rows must not wipe mid-typing edits)
  const seedKey = initial === null ? null : (editing?.id ?? 'new');
  useEffect(() => {
    setName(editing?.name ?? '');
    setIcon(editing?.icon ?? DEBT_ICONS[0]);
    setAccountId(editing?.accountId ?? '');
    setOriginal(editing?.originalCents ? (editing.originalCents / 100).toFixed(2) : '');
    setRemaining('');
    setApr(editing?.interestPctYear !== undefined ? String(editing.interestPctYear) : '');
    setPayment(editing?.paymentCents ? (editing.paymentCents / 100).toFixed(2) : '');
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  const liabilities = (accounts ?? []).filter((a) => a.archived !== 1 && LIABILITY_TYPES.has(a.type));
  const originalCents = parseCents(original);
  const creating = accountId === NEW_ACCOUNT;
  const valid = name.trim().length > 0 && originalCents !== null && originalCents > 0 && accountId !== '';

  const save = async () => {
    if (!valid || originalCents === null) return;
    const paymentCents = parseCents(payment);
    const aprNumber = Number.parseFloat(apr.replace(',', '.'));
    let backingId = accountId;
    if (creating) {
      // the quick-created loan account opens at the remaining value (or
      // the original) — from here only transactions move it
      const openingCents = parseCents(remaining) ?? originalCents;
      backingId = repo.newId();
      const space = await store.get('space', spaceId);
      await repo.upsert('account', spaceId, backingId, {
        name: name.trim(),
        type: 'loan',
        source: 'manual',
        currency: space?.currency ?? 'EUR',
        balanceCents: -Math.abs(openingCents),
        balanceAsOf: manualBalanceDate(),
      });
      void logActivity(store, repo, spaceId, 'accountAdd', name.trim());
    }
    await ops.save(editing?.id ?? null, {
      name: name.trim(),
      icon,
      accountId: backingId,
      originalCents,
      // remaining is the ACCOUNT's business now — never stored again
      remainingCents: undefined,
      // 0% is a real answer; only the EMPTY field means "remind me"
      interestPctYear: Number.isFinite(aprNumber) && aprNumber >= 0 ? aprNumber : undefined,
      paymentCents: paymentCents && paymentCents > 0 ? paymentCents : undefined,
      archived: editing?.archived ?? 0,
    });
    onClose();
  };

  const removeDebt = async () => {
    if (!editing) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await ops.remove(editing.id);
    onClose();
  };

  return (
    <Sheet open={initial !== null} onOpenChange={(open) => !open && onClose()} title={editing ? t('debts.edit') : t('debts.new')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        <div className="flex gap-2 overflow-x-auto pb-1">
          {DEBT_ICONS.map((candidate) => (
            <button
              key={candidate}
              data-testid={`debtform-icon-${candidate}`}
              onClick={() => setIcon(candidate)}
              className={`m-tap flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${
                icon === candidate ? 'border-accent bg-accent-soft text-accent-deep' : 'border-line bg-surface text-ink-2'
              }`}
            >
              <Icon name={candidate} size={19} />
            </button>
          ))}
        </div>
        <input
          data-testid="debtform-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('debts.namePlaceholder')}
          className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        {/* the backing loan account is MANDATORY — its balance is the
            remaining truth, and only transactions move it */}
        <div className="m-cap px-1">{t('debts.linkAccount')}</div>
        <select
          data-testid="debtform-account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="h-12 w-full rounded-input border border-line bg-surface px-3 text-[14px] text-ink"
        >
          <option value="">{t('debts.pickAccount')}</option>
          {liabilities.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {fmt(a.balanceCents, a.currency)}
            </option>
          ))}
          <option value={NEW_ACCOUNT}>{t('debts.newAccount')}</option>
        </select>
        <div className="m-cap px-1">{t('debts.original')}</div>
        <input
          data-testid="debtform-original"
          type="number"
          inputMode="decimal"
          step="0.01"
          min="0"
          value={original}
          onChange={(e) => setOriginal(e.target.value)}
          placeholder="0.00"
          className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
        />
        {creating && (
          <>
            {/* seeds the fresh loan account's opening balance, once —
                afterwards only transactions move it */}
            <div className="m-cap px-1">{t('debts.remaining')}</div>
            <input
              data-testid="debtform-remaining"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={remaining}
              onChange={(e) => setRemaining(e.target.value)}
              placeholder={original || '0.00'}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
          </>
        )}
        <div className="flex gap-2">
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {t('debts.apr')}
            <input
              data-testid="debtform-apr"
              type="number"
              inputMode="decimal"
              step="0.1"
              min="0"
              value={apr}
              onChange={(e) => setApr(e.target.value)}
              placeholder="0.0"
              className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
            />
          </label>
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {t('debts.payment')}
            <input
              data-testid="debtform-payment"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
              placeholder="0.00"
              className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
            />
          </label>
        </div>
        <Button data-testid="debtform-save" onClick={() => void save()} disabled={!valid}>
          {editing ? t('action.save') : t('action.create')}
        </Button>
        {editing && (
          <Button variant="danger" data-testid="debtform-delete" onClick={() => void removeDebt()}>
            {confirmDelete ? t('action.confirm') : t('action.delete')}
          </Button>
        )}
      </div>
    </Sheet>
  );
}

/** All debts: how deep, how fast out. */
export function DebtsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const statuses = useDebtStatuses();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const [formInitial, setFormInitial] = useState<DebtRow | 'new' | null>(null);

  const { fmt } = useDisplayMoney();
  const money = (cents: number) => fmt(cents, currency);
  const active = (statuses ?? []).filter((s) => s.debt.archived !== 1);
  const totalOwed = active.reduce((sum, s) => sum + s.remainingCents, 0);
  const totalMonthly = active.reduce((sum, s) => sum + (s.debt.paymentCents ?? 0), 0);
  const today = localToday();

  const renderCard = (status: DebtStatus) => {
    const { debt, remainingCents, progress } = status;
    const projection = projectPayoff(remainingCents, debt.paymentCents, debt.interestPctYear, today);
    const freeLabel = projection
      ? new Date(`${projection.endMonth}-01`).toLocaleDateString(LOCALES[lang], { month: 'short', year: 'numeric' })
      : null;
    return (
      <button
        key={debt.id}
        data-testid={`debt-card-${debt.id}`}
        onClick={() => void navigate({ to: '/debts/$debtId', params: { debtId: debt.id } })}
        className={`m-tap w-full rounded-card border border-line bg-surface p-4 text-left ${debt.archived === 1 ? 'opacity-60' : ''}`}
      >
        <div className="flex items-center gap-3">
          <Tile icon={debt.icon ?? 'hand-coin-outline'} tone="negative" />
          <span className="min-w-0 flex-1">
            <span className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-semibold text-ink">{debt.name}</span>
              <span className="m-num shrink-0 text-[14px] font-semibold text-ink" data-testid={`debt-remaining-${debt.id}`}>
                {money(remainingCents)}
              </span>
            </span>
            <span className="block text-[11px] text-ink-4">
              {t('budgets.of', { amount: money(debt.originalCents) })}
              {debt.paymentCents ? ` · ${t('debts.perMonth', { amount: money(debt.paymentCents) })}` : ''}
              {freeLabel ? ` · ${t('debts.freeBy', { date: freeLabel })}` : ''}
            </span>
          </span>
        </div>
        <ProgressBar className="mt-3" value={progress} />
      </button>
    );
  };

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-debts">
      <AppBar
        title={t('debts.title')}
        leading={
          <IconButton label={t('action.back')} testId="debts-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <>
            <HelpButton tourId="debts" />
            <IconButton label={t('debts.new')} testId="debts-add" onClick={() => setFormInitial('new')}>
              <Icon name="plus" size={22} />
            </IconButton>
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <IntroCard tourId="debts" />
        {active.length > 0 && (
          <div className="grid grid-cols-2 gap-3 rounded-card border border-line bg-surface p-4" data-testid="debts-overview">
            <div>
              <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t('debts.totalOwed')}</div>
              <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{money(totalOwed)}</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t('debts.totalMonthly')}</div>
              <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{money(totalMonthly)}</div>
            </div>
          </div>
        )}
        <div className="flex flex-col gap-2.5 pt-3">{(statuses ?? []).map(renderCard)}</div>
        {statuses?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="debts-empty">
            <Icon name="hand-coin-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('debts.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('debts.emptyBody')}</p>
          </div>
        )}
      </div>
      <DebtFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
    </div>
  );
}
