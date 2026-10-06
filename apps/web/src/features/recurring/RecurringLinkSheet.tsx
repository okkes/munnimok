import { useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { localToday, useRecurringOps } from '@/application/recurring';
import type { RecurringRow } from '@/db/types';
import { REIMBURSED_ID } from '@/domain/categories';
import { addDays, occurrencesBetween } from '@/domain/recurring';
import { filterTxs } from '@/domain/txFilter';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

/** days either side of a due date that count as "around it" (user 2026-10-06) */
export const NEAR_DUE_DAYS = 7;

const utcDay = (iso: string): number => {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};

/** charges a recurring could take: negative, not linked anywhere (its own
 *  payments are listed on the screen), not a multi-part container (the
 *  reconciler's rule - parts link from their own pages) */
export function linkableCharges(txs: readonly SpaceTx[]): SpaceTx[] {
  return txs.filter(
    (tx) => tx.deleted === 0 && tx.amountCents < 0 && !tx.recurringId && (tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length <= 1,
  );
}

/** the charges within NEAR_DUE_DAYS of a due date of the past year or the
 *  coming weeks, newest first - the quick pick before any search */
export function chargesNearDue(rec: RecurringRow, charges: readonly SpaceTx[], today: string): SpaceTx[] {
  const due = occurrencesBetween(rec, addDays(today, -400), addDays(today, 45)).map(utcDay);
  if (due.length === 0) return [];
  const near = charges.filter((tx) => {
    const day = utcDay(tx.date);
    return due.some((d) => Math.abs(day - d) <= NEAR_DUE_DAYS);
  });
  return [...near].sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * User 2026-10-06: "allow me to add transactions from a recurring cost
 * screen" - the creation flow proposes charges once, and afterwards there
 * was no way to find one. The quick segment is every unlinked charge around
 * a due date; typing searches every transaction. A tap links the charge
 * (the same op the creation sheet uses, which re-files it under the
 * recurring's category) and the row leaves the list for the payments.
 */
export function RecurringLinkSheet({ rec, onClose }: Readonly<{ rec: RecurringRow | null; onClose: () => void }>) {
  const { t } = useLang();
  const ops = useRecurringOps();
  const txs = useSpaceTransactions();
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  const charges = useMemo(() => linkableCharges(txs ?? []), [txs]);
  const near = useMemo(() => (rec ? chargesNearDue(rec, charges, localToday()) : []), [rec, charges]);
  const q = query.trim();
  const found = useMemo(() => {
    if (!q) return [];
    const pool = (txs ?? []).filter((tx) => tx.deleted === 0 && !tx.recurringId);
    return filterTxs(pool, { query: q })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 100);
  }, [txs, q]);

  const link = async (tx: SpaceTx) => {
    if (!rec || busyId) return;
    setBusyId(tx.id);
    try {
      await ops.linkTx(tx, rec.id);
    } finally {
      setBusyId(null);
    }
  };
  const close = (next: boolean) => {
    if (next) return;
    setQuery('');
    onClose();
  };
  const list = (rows: SpaceTx[], testId: string) => (
    <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3 py-1" data-testid={testId}>
      {rows.map((tx) => (
        <TxRow key={tx.id} tx={tx} showDate onClick={() => void link(tx)} />
      ))}
    </div>
  );

  return (
    <Sheet open={rec !== null} onOpenChange={close} title={t('recurring.linkPayment')} size="full">
      <div className="sticky top-0 z-10 -mx-5 bg-bg px-5 pb-2">
        <SearchField testId="reclink-search" value={query} onChange={setQuery} placeholder={t('recurring.linkSearchHint')} />
      </div>
      <p className="px-1 pb-2 text-[12px] leading-snug text-ink-3">{t('recurring.linkHint', { name: rec?.name ?? '' })}</p>
      {q ? (
        <>
          <div className="m-cap mb-1 px-1">
            {t('recurring.linkAll')} · {found.length}
          </div>
          {found.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid="reclink-all-empty">
              {t('recurring.linkNoneFound')}
            </p>
          ) : (
            list(found, 'reclink-all')
          )}
        </>
      ) : (
        <>
          <div className="m-cap mb-1 px-1">{t('recurring.linkNear', { days: NEAR_DUE_DAYS })}</div>
          {near.length === 0 ? (
            <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid="reclink-near-empty">
              {t('recurring.linkNearEmpty')}
            </p>
          ) : (
            list(near, 'reclink-near')
          )}
        </>
      )}
    </Sheet>
  );
}
