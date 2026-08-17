import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useRecurringOps } from '@/application/recurring';
import { REIMBURSED_ID } from '@/domain/categories';
import { merchantKey } from '@/domain/merchantKey';
import { cycleKeyOf, recurringAmountMatches } from '@/domain/recurring';
import { Button } from '@/ui/Button';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

/**
 * #257 (user): accepting a detected recurring cost no longer links its
 * charges blind — this sheet lists every candidate payment (same rules
 * the auto-reconciler uses) with the reconciler's own picks pre-checked,
 * and the user prunes before anything is written. Applying links the
 * picked rows through linkTx, which also re-files them under the
 * recurring's category (the second half of the issue).
 */
export function RecurringMatchSheet({ recId, onClose }: Readonly<{ recId: string | null; onClose: () => void }>) {
  const { t } = useLang();
  const { store } = useData();
  const ops = useRecurringOps();
  const txs = useSpaceTransactions();
  const rec = useQuery(store, async () => (recId ? store.get('recurring', recId) : undefined), [recId]);
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const candidates = useMemo<SpaceTx[]>(() => {
    if (!rec?.merchantKey || !txs) return [];
    const rows = txs.filter((tx) => {
      if (tx.deleted !== 0 || tx.amountCents >= 0 || tx.txType !== 'expense') return false;
      if (tx.recurringId && tx.recurringId !== rec.id) return false;
      // container rule mirrors the reconciler: parts link from their own pages
      if ((tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1) return false;
      return merchantKey(tx.merchant) === rec.merchantKey && recurringAmountMatches(rec, tx.amountCents);
    });
    rows.sort((a, b) => b.date.localeCompare(a.date));
    return rows;
  }, [rec, txs]);

  // the reconciler's own selection (one charge per billing cycle) arrives
  // pre-checked ONCE per recurring; live-query re-emissions must never
  // clobber the user's pruning (LoanMatchSheet pattern)
  const seededFor = useRef<string | null>(null);
  useEffect(() => {
    if (!recId) {
      seededFor.current = null;
      return;
    }
    if (seededFor.current === recId || !rec || candidates.length === 0) return;
    seededFor.current = recId;
    const cycles = new Set<string>();
    const auto = new Set<string>();
    for (const tx of [...candidates].sort((a, b) => a.date.localeCompare(b.date))) {
      const cycle = cycleKeyOf(rec, tx.date);
      if (cycles.has(cycle)) continue;
      cycles.add(cycle);
      auto.add(tx.id);
    }
    setPicked(auto);
  }, [recId, rec, candidates]);

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const apply = async () => {
    if (!recId || busy) return;
    setBusy(true);
    try {
      for (const tx of candidates) {
        if (!picked.has(tx.id)) continue;
        await ops.linkTx(tx, recId);
      }
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={recId !== null} onOpenChange={(next) => !next && onClose()} title={t('recurring.matchTitle')} size="tall">
      <p className="pb-2 text-[12px] leading-snug text-ink-3">{t('recurring.matchHint', { name: rec?.name ?? '' })}</p>
      {candidates.length === 0 && (
        <p className="px-1 py-6 text-center text-[13px] text-ink-4" data-testid="recmatch-empty">
          {t('recurring.matchEmpty')}
        </p>
      )}
      <div className="flex flex-col" data-testid="recmatch-list">
        {candidates.map((tx) => (
          <label key={tx.id} className="flex items-center gap-2 border-b border-line-2 py-1 last:border-0">
            <input
              data-testid={`recmatch-pick-${tx.id}`}
              type="checkbox"
              checked={picked.has(tx.id)}
              onChange={() => toggle(tx.id)}
              className="h-5 w-5 shrink-0 accent-[var(--m-accent)]"
            />
            <span className="min-w-0 flex-1">
              <TxRow tx={tx} showDate />
            </span>
          </label>
        ))}
      </div>
      {candidates.length > 0 && (
        <Button className="mt-3 w-full" data-testid="recmatch-apply" disabled={busy || picked.size === 0} onClick={() => void apply()}>
          {t('recurring.matchApply', { n: picked.size })}
        </Button>
      )}
    </Sheet>
  );
}
