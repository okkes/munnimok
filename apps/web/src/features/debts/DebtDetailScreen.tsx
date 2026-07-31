import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useDebtStatuses } from '@/application/debts';
import { useSpaceTransactions } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { estimatePaymentPlan, paymentsPerYear, projectPayoff } from '@/domain/debts';
import { merchantKey } from '@/domain/merchantKey';
import type { DebtRow } from '@/db/types';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { TxFormSheet } from '@/features/transactions/TxFormSheet';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { HeroCard, ProgressBar, Tile } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';
import { DebtFormSheet, paymentLabelKey } from './DebtsScreen';

/** One debt: the payoff story — numbers, projection, payment history. */
export function DebtDetailScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const { debtId } = useParams({ strict: false }) as { debtId: string };
  const statuses = useDebtStatuses();
  const txs = useSpaceTransactions();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [formInitial, setFormInitial] = useState<DebtRow | 'new' | null>(null);
  const [paymentOpen, setPaymentOpen] = useState(false);

  const status = statuses?.find((s) => s.debt.id === debtId);
  // deleted here or on another device: leave the orphaned detail
  useEffect(() => {
    if (statuses && !status) void navigate({ to: '/debts', replace: true });
  }, [statuses, status, navigate]);
  const today = localToday();

  // payment history: transactions on the linked account, or expenses
  // matching the debt's merchant pattern (read-only view)
  const payments = useMemo(() => {
    if (!status || !txs) return [];
    const { debt } = status;
    return txs
      .filter((tx) => {
        if (tx.deleted !== 0) return false;
        // a transfer NAMING the backing account as counterparty is this
        // debt's payment — the main path since debts went account-backed
        if (debt.accountId) return tx.accountId === debt.accountId || tx.linkedAccountId === debt.accountId;
        if (debt.merchantKey) return tx.txType === 'debtPayment' || merchantKey(tx.merchant) === debt.merchantKey;
        return tx.txType === 'debtPayment' && tx.linkedAccountId === undefined;
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 50);
  }, [status, txs]);

  const { fmt } = useDisplayMoney();
  if (!status) return <div className="h-full" data-testid="screen-debt-detail" />;

  const { debt, remainingCents, progress } = status;
  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmt(cents, currency);
  // the explicit plan wins; with the fields empty, ≥3 payments speak for
  // themselves ("estimated from payments", arc 3) — never stored
  const estimate = debt.paymentCents ? null : estimatePaymentPlan(payments);
  const projection = debt.paymentCents
    ? projectPayoff(remainingCents, debt.paymentCents, debt.interestPctYear, today, paymentsPerYear(debt.paymentEvery, debt.paymentEveryN))
    : projectPayoff(remainingCents, estimate?.paymentCents, debt.interestPctYear, today, estimate?.perYear ?? 12);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-debt-detail">
      <AppBar
        title={debt.name}
        leading={
          <IconButton label={t('action.back')} testId="debtdetail-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <IconButton label={t('debts.edit')} testId="debtdetail-edit" onClick={() => setFormInitial(debt)}>
            <Icon name="pencil-outline" size={20} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <HeroCard
          testId="debtdetail-hero"
          tile={<Tile size={48} tone="negative" icon={debt.icon ?? 'hand-coin-outline'} />}
          number={<span data-testid="debtdetail-remaining">{money(remainingCents)}</span>}
          // without the original size there is no "of …" story and no
          // honest progress — the hero stays a plain remaining figure
          sub={debt.originalCents ? t('debts.remainingOf', { amount: money(debt.originalCents) }) : undefined}
          right={
            debt.originalCents ? (
              <span className="m-num shrink-0 text-[14px] font-semibold text-accent-deep">{Math.round(progress * 100)}%</span>
            ) : undefined
          }
          progress={debt.originalCents ? <ProgressBar value={progress} /> : undefined}
          meta={
            <>
              {debt.paymentCents && (
                <span>{t(paymentLabelKey(debt.paymentEvery), { amount: money(debt.paymentCents) })}</span>
              )}
              {estimate && (
                <span data-testid="debtdetail-estimate">
                  {t('debts.estimatedPlan', { amount: money(estimate.paymentCents), days: estimate.everyDays })}
                </span>
              )}
              {debt.interestPctYear !== undefined && <span>{debt.interestPctYear}% {t('debts.aprShort')}</span>}
              {projection && (
                <span data-testid="debtdetail-projection">
                  {t('debts.projection', {
                    date: new Date(`${projection.endMonth}-01`).toLocaleDateString(LOCALES[lang], { month: 'long', year: 'numeric' }),
                    interest: money(projection.totalInterestCents),
                  })}
                </span>
              )}
            </>
          }
        />
        {debt.note && (
          <p className="mt-3 rounded-card border border-line bg-surface px-4 py-3 text-[13px] leading-relaxed text-ink-2" data-testid="debtdetail-note">
            {debt.note}
          </p>
        )}

        {/* a hand-entered payment, pre-staged onto this loan (arc 3):
            the manual form opens as a transfer to the backing account */}
        {debt.accountId && (
          <Button
            variant="outline"
            className="mt-4 w-full"
            data-testid="debtdetail-add-payment"
            onClick={() => setPaymentOpen(true)}
          >
            <Icon name="plus" size={16} /> {t('debts.addPayment')}
          </Button>
        )}

        <div className="m-cap mt-5 mb-1 px-1">
          {t('debts.payments')} · {payments.length}
        </div>
        {payments.length > 0 ? (
          <div className="rounded-card border border-line bg-surface px-3 py-1" data-testid="debtdetail-payments">
            {payments.map((tx) => (
              <TxRow key={tx.id} tx={tx} showDate onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })} />
            ))}
          </div>
        ) : (
          <p className="px-1 text-[12px] text-ink-4" data-testid="debtdetail-nopayments">
            {t('debts.noPayments')}
          </p>
        )}
      </div>
      <DebtFormSheet initial={formInitial} onClose={() => setFormInitial(null)} />
      {debt.accountId && (
        <TxFormSheet
          open={paymentOpen}
          onOpenChange={setPaymentOpen}
          prefill={{ linkedAccountId: debt.accountId, merchant: debt.name }}
        />
      )}
    </div>
  );
}
