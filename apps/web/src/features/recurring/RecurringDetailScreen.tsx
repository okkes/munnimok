import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useNavigate, useParams } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useSpaceTransactions } from '@/application/transactions';
import { localToday } from '@/application/recurring';
import { nextDueDate } from '@/domain/recurring';
import { fmtCents } from '@/lib/money';
import { RecurringFormSheet, formFromRec } from './RecurringFormSheet';
import type { FormState } from './RecurringFormSheet';
import { HeroCard, Pill, Tile } from '@/ui/primitives';
import { SplitPane } from '@/ui/SplitPane';
import { RecurringScreen } from './RecurringScreen';
import { RecurringVisual, cadenceLabel } from './RecurringVisual';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { TxRow } from '@/ui/TxRow';

/**
 * One recurring cost, in full: what it is, when it hits next, and every
 * payment ever linked to it. A screen rather than a sheet — the payment
 * history deserves room, and each row leads on to the transaction.
 */
export function RecurringDetailScreen() {
  const { t, lang } = useLang();
  const { db, spaceId } = useData();
  const { recId } = useParams({ strict: false }) as { recId: string };
  const navigate = useNavigate();
  const [formInitial, setFormInitial] = useState<FormState | null>(null);

  // 'loading' sentinel: Dexie's get() yields undefined both while loading
  // and for a missing row — only the latter should bounce the screen
  const rec = useLiveQuery(() => db.recurrings.get(recId), [db, recId], 'loading' as const);
  const txs = useSpaceTransactions();
  const space = useLiveQuery(() => db.spaces.get(spaceId), [spaceId]);
  const currency = space?.currency ?? 'EUR';
  const money = (cents: number) => fmtCents(cents, currency, lang);

  // deleted elsewhere (other device, or via the edit sheet) — leave
  const gone = rec !== 'loading' && (rec === undefined || rec.deleted !== 0 || rec.spaceId !== spaceId);
  useEffect(() => {
    if (gone) void navigate({ to: '/recurring', replace: true });
  }, [gone, navigate]);

  const payments = useMemo(
    () => (txs ?? []).filter((tx) => tx.recurringId === recId).sort((a, b) => b.date.localeCompare(a.date)),
    [txs, recId],
  );

  const stats = useMemo(() => {
    const year = localToday().slice(0, 4);
    const thisYear = payments.filter((tx) => tx.date.startsWith(year));
    const total = thisYear.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
    const avg = payments.length
      ? Math.round(payments.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0) / payments.length)
      : 0;
    return { yearCents: total, count: payments.length, avgCents: avg };
  }, [payments]);

  if (rec === 'loading' || gone)
    return (
      <SplitPane list={<RecurringScreen />}>
        <div className="h-full" data-testid="screen-recurring-detail" />
      </SplitPane>
    );

  const nextDue = nextDueDate(rec, localToday());
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' });

  return (
    // §4.2: at lg the recurring list stays beside the detail
    <SplitPane list={<RecurringScreen />}>
    <div className="m-fade flex h-full flex-col" data-testid="screen-recurring-detail">
      <AppBar
        title={rec.name}
        leading={
          <IconButton label={t('action.back')} testId="recdetail-back" onClick={() => window.history.back()}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
        trailing={
          <IconButton label={t('recurring.edit')} testId="recdetail-edit" onClick={() => setFormInitial(formFromRec(rec))}>
            <Icon name="pencil-outline" size={20} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {/* hero: what this cost is */}
        <HeroCard
          className="mt-1"
          testId="recdetail-hero"
          tile={
            <Tile size={48} tone={rec.active === 1 ? 'accent' : 'neutral'}>
              <RecurringVisual rec={rec} size={24} active={rec.active === 1} />
            </Tile>
          }
          title={rec.name}
          titleBadge={
            rec.luxury === 1 ? (
              <Pill tone="accent" caps>
                {t('recurring.luxury')}
              </Pill>
            ) : undefined
          }
          sub={`${t(rec.kind === 'fixed' ? 'recurring.kindFixed' : 'recurring.kindSub')} · ${cadenceLabel(rec, t)}`}
          number={<span data-testid="recdetail-amount">{money(rec.amountCents)}</span>}
          meta={
            <>
              {rec.active === 1 && nextDue && (
                <span className="flex items-center gap-1" data-testid="recdetail-next">
                  <Icon name="calendar-clock" size={13} />
                  {t('recurring.next', { date: fmtDate(nextDue) })}
                </span>
              )}
              {rec.active !== 1 && <span data-testid="recdetail-inactive">{t('recurring.inactive')}</span>}
              {(rec.notifyDaysBefore ?? 0) > 0 && (
                <span className="flex items-center gap-1">
                  <Icon name="bell-outline" size={13} />
                  {t('recurring.notifyDays', { n: rec.notifyDaysBefore! })}
                </span>
              )}
            </>
          }
        />

        {/* the numbers the payment history adds up to */}
        <div className="mt-3 grid grid-cols-3 gap-3 rounded-card border border-line bg-surface p-4" data-testid="recdetail-stats">
          {(
            [
              ['recurring.paidThisYear', money(stats.yearCents)],
              ['recurring.chargesCount', String(stats.count)],
              ['recurring.avgCharge', money(stats.avgCents)],
            ] as const
          ).map(([key, value]) => (
            <div key={key}>
              <div className="text-[10px] font-semibold tracking-wide text-ink-4 uppercase">{t(key)}</div>
              <div className="mt-0.5 font-mono text-[15px] font-semibold text-ink">{value}</div>
            </div>
          ))}
        </div>

        <div className="m-cap mt-5 mb-1 px-1">
          {t('recurring.payments')} · {payments.length}
        </div>
        {payments.length > 0 ? (
          <div className="rounded-card border border-line bg-surface px-3 py-1" data-testid="recdetail-payments">
            {payments.map((tx) => (
              <TxRow key={tx.id} tx={tx} onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id } })} />
            ))}
          </div>
        ) : (
          <p className="px-1 text-[12px] text-ink-4" data-testid="recdetail-no-payments">
            {t('recurring.detailNoPayments')}
          </p>
        )}
      </div>

      <RecurringFormSheet
        initial={formInitial}
        onClose={() => setFormInitial(null)}
        onDeleted={() => void navigate({ to: '/recurring', replace: true })}
      />
    </div>
    </SplitPane>
  );
}
