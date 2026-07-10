import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useDebtStatuses } from '@/application/debts';
import { useSpaceTransactions } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { projectPayoff } from '@/domain/debts';
import { merchantKey } from '@/domain/merchantKey';
import type { DebtRow } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { ProgressBar } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';
import { DebtFormSheet } from './DebtsScreen';

/** One debt: the payoff story — numbers, projection, payment history. */
export function DebtDetailScreen() {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { db, spaceId } = useData();
  const { debtId } = useParams({ strict: false }) as { debtId: string };
  const statuses = useDebtStatuses();
  const txs = useSpaceTransactions();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const [formInitial, setFormInitial] = useState<DebtRow | 'new' | null>(null);

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
        if (debt.accountId) return tx.accountId === debt.accountId;
        if (debt.merchantKey) return tx.txType === 'debtPayment' || merchantKey(tx.merchant) === debt.merchantKey;
        return tx.txType === 'debtPayment' && tx.linkedAccountId === undefined;
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 50);
  }, [status, txs]);

  if (!status) return <div className="h-full" data-testid="screen-debt-detail" />;

  const { debt, remainingCents, progress } = status;
  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmtCents(cents, currency, lang);
  const projection = projectPayoff(remainingCents, debt.paymentCents, debt.interestPctYear, today);

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
        <div className="rounded-card border border-line bg-surface p-4" data-testid="debtdetail-hero">
          <div className="flex items-center gap-3">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-negative-soft text-negative">
              <Icon name={debt.icon ?? 'hand-coin-outline'} size={22} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="m-num block text-[24px] font-semibold text-ink" data-testid="debtdetail-remaining">
                {money(remainingCents)}
              </span>
              <span className="block text-[12px] text-ink-3">{t('debts.remainingOf', { amount: money(debt.originalCents) })}</span>
            </span>
            <span className="m-num shrink-0 text-[14px] font-semibold text-accent-deep">{Math.round(progress * 100)}%</span>
          </div>
          <ProgressBar className="mt-3" value={progress} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-ink-3">
            {debt.paymentCents && <span>{t('debts.perMonth', { amount: money(debt.paymentCents) })}</span>}
            {debt.interestPctYear !== undefined && <span>{debt.interestPctYear}% {t('debts.aprShort')}</span>}
            {projection && (
              <span data-testid="debtdetail-projection">
                {t('debts.projection', {
                  date: new Date(`${projection.endMonth}-01`).toLocaleDateString(LOCALES[lang], { month: 'long', year: 'numeric' }),
                  interest: money(projection.totalInterestCents),
                })}
              </span>
            )}
          </div>
        </div>

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
    </div>
  );
}
