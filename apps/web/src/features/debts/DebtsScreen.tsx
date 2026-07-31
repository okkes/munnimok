import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@/db/useQuery';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useDebtOps, useDebtStatuses } from '@/application/debts';
import type { DebtStatus } from '@/application/debts';
import { logActivity } from '@/application/activity';
import { manualBalanceDate } from '@/features/accounts/accountTypes';
import { useSpaceAccounts, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { monthlyPaymentCents, paymentsPerYear, projectPayoff } from '@/domain/debts';
import type { DebtRow, RecurringEvery } from '@/db/types';
import { parseCents } from '@/lib/money';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { HelpButton } from '@/features/help/HelpButton';
import { IntroCard } from '@/features/help/IntroCard';
import { takeDebtHandoff } from './handoff';
import type { DebtHandoff } from './handoff';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip, ProgressBar, Tile } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

export const DEBT_ICONS = ['home-percent-outline', 'credit-card-outline', 'car-outline', 'school-outline', 'hand-coin-outline', 'account-cash-outline'] as const;
const LIABILITY_TYPES = new Set(['credit', 'mortgage', 'loan']);
const CADENCES = ['week', 'month', 'year'] as const;
const CADENCE_LABEL = { week: 'recurring.everyWeek', month: 'recurring.everyMonth', year: 'recurring.everyYear' } as const;
const PAYMENT_LABEL = { week: 'debts.perWeek', month: 'debts.perMonth', year: 'debts.perYear' } as const;

/** "{amount} / week|month|year" — the payment line follows the cadence */
export const paymentLabelKey = (every?: RecurringEvery): (typeof PAYMENT_LABEL)[keyof typeof PAYMENT_LABEL] =>
  PAYMENT_LABEL[every ?? 'month'];

type LoanDeps = { store: ReturnType<typeof useData>['store']; repo: ReturnType<typeof useData>['repo']; spaceId: string };

/** mint the backing loan account, or correct a manual one's anchor
 *  balance + IBAN; bank-fed accounts are the bank's and stay untouched
 *  (S3776: the form's account half lives out of the component) */
async function ensureBackingAccount(
  deps: LoanDeps,
  backing: { id: string; source: string; balanceCents: number; iban?: string } | undefined,
  args: { name: string; iban: string; currentCents: number | null },
): Promise<string> {
  const { store, repo, spaceId } = deps;
  if (!backing) {
    const backingId = repo.newId();
    const space = await store.get('space', spaceId);
    await repo.upsert('account', spaceId, backingId, {
      name: args.name,
      type: 'loan',
      source: 'manual',
      currency: space?.currency ?? 'EUR',
      balanceCents: -Math.abs(args.currentCents ?? 0),
      balanceAsOf: manualBalanceDate(),
      ...(args.iban ? { iban: args.iban } : {}),
    });
    void logActivity(store, repo, spaceId, 'accountAdd', args.name);
    return backingId;
  }
  if (backing.source === 'manual') {
    const nextBalance = -Math.abs(args.currentCents ?? 0);
    if (nextBalance !== backing.balanceCents || args.iban !== (backing.iban ?? '')) {
      await repo.upsert('account', spaceId, backing.id, {
        balanceCents: nextBalance,
        balanceAsOf: manualBalanceDate(),
        ...(args.iban ? { iban: args.iban } : {}),
      });
    }
  }
  return backing.id;
}

/**
 * The merged Loan form (arc 3): ONE sheet mints the backing loan account
 * and the debt together — the old two-object dance was the friction.
 * Current value is the required truth anchor (the account's balance,
 * stored negative); the original size is optional garnish, and the
 * payment gets a cadence. Picking an existing liability account stays
 * possible for bank-fed loans — their balance is the bank's and reads
 * read-only here.
 */
export function DebtFormSheet({
  initial,
  prefill,
  onClose,
}: Readonly<{ initial: DebtRow | 'new' | null; prefill?: DebtHandoff; onClose: () => void }>) {
  const { t } = useLang();
  const { fmt } = useDisplayMoney();
  const ops = useDebtOps();
  const { store, repo, spaceId } = useData();
  const accounts = useSpaceAccounts();
  const editing = initial !== 'new' && initial !== null ? initial : null;
  const [name, setName] = useState('');
  const [icon, setIcon] = useState<string>(DEBT_ICONS[0]);
  /** '' = mint a fresh manual loan account on save (the default) */
  const [accountId, setAccountId] = useState('');
  const [current, setCurrent] = useState('');
  const [original, setOriginal] = useState('');
  const [iban, setIban] = useState('');
  const [apr, setApr] = useState('');
  const [payment, setPayment] = useState('');
  const [paymentEvery, setPaymentEvery] = useState<(typeof CADENCES)[number]>('month');
  const [note, setNote] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const backing = (accounts ?? []).find((a) => a.id === accountId);
  const bankBacked = !!backing && backing.source !== 'manual';

  // seed keyed on the record's ID, never object identity (the iOS
  // reseed class: re-emitted rows must not wipe mid-typing edits)
  const seedKey = initial === null ? null : (editing?.id ?? 'new');
  useEffect(() => {
    // a fresh sheet may arrive PREFILLED (the recurring form's Debt
    // kind hands its facts over)
    setName(editing?.name ?? prefill?.name ?? '');
    setIcon(editing?.icon ?? DEBT_ICONS[0]);
    setAccountId(editing?.accountId ?? '');
    const seededOriginal = editing?.originalCents ?? prefill?.originalCents;
    setOriginal(seededOriginal ? (seededOriginal / 100).toFixed(2) : '');
    setCurrent('');
    setIban('');
    setApr(editing?.interestPctYear === undefined ? '' : String(editing.interestPctYear));
    setPayment(editing?.paymentCents ? (editing.paymentCents / 100).toFixed(2) : '');
    setPaymentEvery(editing?.paymentEvery ?? 'month');
    setNote(editing?.note ?? '');
    setConfirmDelete(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  // the picked account seeds current value + IBAN (its balance IS the
  // remaining truth); a re-pick re-seeds, mid-typing edits survive a
  // background re-emit because accountId itself is state
  useEffect(() => {
    if (backing) {
      setCurrent((Math.abs(backing.balanceCents) / 100).toFixed(2));
      setIban(backing.iban ?? '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backing?.id]);

  const liabilities = (accounts ?? []).filter((a) => a.archived !== 1 && LIABILITY_TYPES.has(a.type));
  const originalCents = parseCents(original);
  const currentCents = parseCents(current);
  // name + a current value are the whole ask; bank-fed balances are the
  // bank's truth and need no typing
  const valid = name.trim().length > 0 && (bankBacked || currentCents !== null);

  const save = async () => {
    if (!valid) return;
    const paymentCents = parseCents(payment);
    const aprNumber = Number.parseFloat(apr.replace(',', '.'));
    const backingId = await ensureBackingAccount({ store, repo, spaceId }, backing, {
      name: name.trim(),
      iban: iban.trim(),
      currentCents,
    });
    const hasPayment = !!paymentCents && paymentCents > 0;
    await ops.save(editing?.id ?? null, {
      name: name.trim(),
      icon,
      accountId: backingId,
      // an auto-detected recurring hands its merchant over — the debt's
      // payment history then includes those past transactions
      ...(editing ? {} : { merchantKey: prefill?.merchantKey }),
      originalCents: originalCents && originalCents > 0 ? originalCents : undefined,
      // remaining is the ACCOUNT's business now — never stored again
      remainingCents: undefined,
      // 0% is a real answer; only the EMPTY field means "remind me"
      interestPctYear: Number.isFinite(aprNumber) && aprNumber >= 0 ? aprNumber : undefined,
      paymentCents: hasPayment ? paymentCents : undefined,
      // stored explicitly with the payment; null CLEARS a stale cadence
      // (undefined would drop from the op and leave 'week' standing)
      paymentEvery: hasPayment ? paymentEvery : (null as never),
      note: note.trim() || undefined,
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
        {/* the truth anchor: what is owed RIGHT NOW — it becomes (or
            corrects) the backing account's balance; bank-fed balances
            are the bank's and read read-only */}
        <div className="m-cap px-1">{t('debts.current')}</div>
        {backing && bankBacked ? (
          <p className="px-1 text-[13px] text-ink-3" data-testid="debtform-current-bank">
            {fmt(Math.abs(backing.balanceCents), backing.currency)} · {t('debts.currentBank')}
          </p>
        ) : (
          <input
            data-testid="debtform-current"
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="0.00"
            className="h-12 w-full rounded-input border border-line bg-surface px-4 font-mono text-[15px] text-ink outline-none placeholder:text-ink-4"
          />
        )}
        {/* default: the loan mints its own account; picking an existing
            liability covers bank-fed loans */}
        <div className="m-cap px-1">{t('debts.linkAccount')}</div>
        <select
          data-testid="debtform-account"
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="h-12 w-full rounded-input border border-line bg-surface px-3 text-[14px] text-ink"
        >
          <option value="">{t('debts.autoAccount')}</option>
          {liabilities.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {fmt(a.balanceCents, a.currency)}
            </option>
          ))}
        </select>
        {!bankBacked && (
          <input
            data-testid="debtform-iban"
            value={iban}
            onChange={(e) => setIban(e.target.value)}
            placeholder={t('debts.iban')}
            className="h-11 w-full rounded-input border border-line bg-surface px-4 font-mono text-[13px] text-ink outline-none placeholder:text-ink-4"
          />
        )}
        <div className="flex gap-2">
          <label className="min-w-0 flex-1 text-[12px] text-ink-3">
            {t('debts.original')}
            <input
              data-testid="debtform-original"
              type="number"
              inputMode="decimal"
              step="0.01"
              min="0"
              value={original}
              onChange={(e) => setOriginal(e.target.value)}
              placeholder="0.00"
              className="mt-1 h-11 w-full rounded-input border border-line bg-surface px-3 font-mono text-[14px] text-ink outline-none placeholder:text-ink-4"
            />
          </label>
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
        </div>
        <div className="flex items-end gap-2">
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
          {/* the payment's cadence (arc 3) — the projection follows it */}
          <div className="flex gap-1.5">
            {CADENCES.map((cadence) => (
              <Chip key={cadence} testId={`debtform-every-${cadence}`} selected={paymentEvery === cadence} onClick={() => setPaymentEvery(cadence)}>
                {t(CADENCE_LABEL[cadence])}
              </Chip>
            ))}
          </div>
        </div>
        <textarea
          data-testid="debtform-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={t('debts.note')}
          rows={2}
          className="w-full resize-none rounded-input border border-line bg-surface px-4 py-2.5 text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
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

/**
 * The virtual "Unassigned payments" bucket (arc 3): bare debt-payment
 * rows (no counter account — the arc-2 exit, or imports) summed as a
 * computed card, never a stored debt. Each row assigns to a loan with
 * one tap — the link files it under that debt's history.
 */
function UnassignedPaymentsCard({
  bare,
  debts,
  currency,
}: Readonly<{ bare: SpaceTx[]; debts: readonly DebtRow[]; currency: string }>) {
  const { t } = useLang();
  const { fmt } = useDisplayMoney();
  const transform = useTxTransform();
  const [open, setOpen] = useState(false);
  const [assignTx, setAssignTx] = useState<SpaceTx | null>(null);
  const targets = debts.filter((d) => d.deleted === 0 && d.archived !== 1 && d.accountId);
  if (bare.length === 0) return null;
  const total = bare.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  return (
    <>
      <button
        data-testid="debts-unassigned"
        onClick={() => setOpen(true)}
        className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-surface p-4 text-left"
      >
        <Tile icon="help-circle-outline" tone="neutral" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-[15px] font-semibold text-ink">{t('debts.unassigned')}</span>
            <span className="m-num shrink-0 text-[14px] font-semibold text-ink">{fmt(total, currency)}</span>
          </span>
          <span className="block text-[11px] text-ink-4">{t('debts.unassignedSub', { n: bare.length })}</span>
        </span>
      </button>
      <Sheet open={open} onOpenChange={setOpen} title={t('debts.unassigned')} size="tall" dragHandle>
        <p className="pb-2 text-[12px] text-ink-3">{t('debts.unassignedHint')}</p>
        <div className="rounded-card border border-line bg-surface px-3 py-1" data-testid="debts-unassigned-list">
          {bare.map((tx) => (
            <TxRow key={tx.id} tx={tx} showDate onClick={() => setAssignTx(tx)} />
          ))}
        </div>
      </Sheet>
      <Sheet open={assignTx !== null} onOpenChange={(next) => !next && setAssignTx(null)} title={t('debts.assignTo')} size="form">
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="debts-assign-options">
          {targets.map((debt) => (
            <button
              key={debt.id}
              data-testid={`debts-assign-${debt.id}`}
              onClick={() => {
                // the link makes it THIS loan's payment (history + matcher
                // agree); the locked category already fits, review stands
                if (assignTx) void transform(assignTx, { linkedAccountId: debt.accountId }, 'txLink');
                setAssignTx(null);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
            >
              <Icon name={debt.icon ?? 'hand-coin-outline'} size={18} color="var(--m-ink-2)" />
              <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{debt.name}</span>
            </button>
          ))}
          {targets.length === 0 && <p className="px-4 py-3 text-[13px] text-ink-4">{t('debts.assignNone')}</p>}
        </div>
      </Sheet>
    </>
  );
}

/** All debts: how deep, how fast out. */
export function DebtsScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const statuses = useDebtStatuses();
  const txs = useSpaceTransactions();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const [formInitial, setFormInitial] = useState<DebtRow | 'new' | null>(null);
  // arriving FROM the recurring form (its Debt kind, user design): the
  // create sheet opens prefilled and Mina explains why debts are their
  // own thing — a closable note, not a gate
  const [handoff] = useState(() => takeDebtHandoff());
  useEffect(() => {
    if (handoff) setFormInitial('new');
  }, [handoff]);
  // counterparty-less debt payments — the virtual bucket's contents
  const bare = useMemo(
    () => (txs ?? []).filter((tx) => tx.deleted === 0 && tx.txType === 'debtPayment' && !tx.linkedAccountId),
    [txs],
  );

  const { fmt } = useDisplayMoney();
  const money = (cents: number) => fmt(cents, currency);
  const active = (statuses ?? []).filter((s) => s.debt.archived !== 1);
  const totalOwed = active.reduce((sum, s) => sum + s.remainingCents, 0);
  // cadence-normalized (arc 3): a weekly €100 reads as ~€433 here
  const totalMonthly = active.reduce((sum, s) => sum + monthlyPaymentCents(s.debt), 0);
  const today = localToday();

  const renderCard = (status: DebtStatus) => {
    const { debt, remainingCents, progress } = status;
    const projection = projectPayoff(
      remainingCents,
      debt.paymentCents,
      debt.interestPctYear,
      today,
      paymentsPerYear(debt.paymentEvery, debt.paymentEveryN),
    );
    const freeLabel = projection
      ? new Date(`${projection.endMonth}-01`).toLocaleDateString(LOCALES[lang], { month: 'short', year: 'numeric' })
      : null;
    const subParts = [
      debt.originalCents ? t('budgets.of', { amount: money(debt.originalCents) }) : null,
      debt.paymentCents ? t(paymentLabelKey(debt.paymentEvery), { amount: money(debt.paymentCents) }) : null,
      freeLabel ? t('debts.freeBy', { date: freeLabel }) : null,
    ].filter(Boolean);
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
            {subParts.length > 0 && <span className="block text-[11px] text-ink-4">{subParts.join(' · ')}</span>}
          </span>
        </div>
        {/* progress needs the original size — without it the bar would lie 0% */}
        {!!debt.originalCents && <ProgressBar className="mt-3" value={progress} />}
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
        <UnassignedPaymentsCard bare={bare} debts={(statuses ?? []).map((s) => s.debt)} currency={currency} />
        <div className="flex flex-col gap-2.5 pt-3">{(statuses ?? []).map(renderCard)}</div>
        {statuses?.length === 0 && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="debts-empty">
            <Icon name="hand-coin-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[14px] font-medium text-ink-2">{t('debts.emptyTitle')}</p>
            <p className="text-[12px] text-ink-4">{t('debts.emptyBody')}</p>
          </div>
        )}
      </div>
      <DebtFormSheet initial={formInitial} prefill={handoff ?? undefined} onClose={() => setFormInitial(null)} />
    </div>
  );
}
