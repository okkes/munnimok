import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
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
import { HeroCard, ProgressBar, Tile } from '@/ui/primitives';
import { TxRow } from '@/ui/TxRow';
import { DebtFormSheet } from './DebtsScreen';

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
        <HeroCard
          testId="debtdetail-hero"
          tile={<Tile size={48} tone="negative" icon={debt.icon ?? 'hand-coin-outline'} />}
          number={<span data-testid="debtdetail-remaining">{money(remainingCents)}</span>}
          sub={t('debts.remainingOf', { amount: money(debt.originalCents) })}
          right={<span className="m-num shrink-0 text-[14px] font-semibold text-accent-deep">{Math.round(progress * 100)}%</span>}
          progress={<ProgressBar value={progress} />}
          meta={
            <>
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
            </>
          }
        />

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
