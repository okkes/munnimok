import { useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents, parseCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { clampReimbursement, remainingCents, totalReimbursedCents, withLink } from '@/domain/reimbursement';
import type { TransactionRow } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * Reimbursement links on an expense: list + unlink, and a picker over
 * recent credit transactions with a clamped amount to link.
 */
export function ReimburseSection({ tx }: { tx: TransactionRow }) {
  const { t, lang } = useLang();
  const { db, repo, spaceId } = useData();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<TransactionRow | null>(null);
  const [amount, setAmount] = useState('');

  const linkedIds = useMemo(() => (tx.reimbursements ?? []).map((r) => r.txId), [tx.reimbursements]);
  const linkedTxs = useLiveQuery(
    async () => (linkedIds.length ? db.transactions.where('id').anyOf(linkedIds).toArray() : []),
    [linkedIds.join(',')],
  );
  const credits = useLiveQuery(
    () =>
      db.transactions
        .where('[spaceId+date]')
        .between([spaceId, ''], [spaceId, '￿'])
        .reverse()
        .filter((c) => c.deleted === 0 && c.amountCents > 0 && c.id !== tx.id && !linkedIds.includes(c.id))
        .limit(30)
        .toArray(),
    [spaceId, tx.id, linkedIds.join(',')],
  );

  if (tx.amountCents >= 0) return null;
  const total = totalReimbursedCents(tx);

  const unlink = (txId: string) =>
    void repo.upsert('transaction', spaceId, tx.id, { reimbursements: withLink(tx.reimbursements, txId, 0) });

  const choose = (credit: TransactionRow) => {
    const prefill = clampReimbursement(tx, credit.amountCents, credit.amountCents);
    setChosen(credit);
    setAmount((prefill / 100).toFixed(2).replace('.', ','));
  };

  const confirm = () => {
    if (!chosen) return;
    const cents = clampReimbursement(tx, chosen.amountCents, parseCents(amount) ?? 0);
    if (cents > 0) {
      void repo.upsert('transaction', spaceId, tx.id, {
        reimbursements: withLink(tx.reimbursements, chosen.id, cents),
      });
    }
    setChosen(null);
    setPickerOpen(false);
  };

  return (
    <>
      <div className="m-cap mt-5 mb-1 flex items-center justify-between px-1">
        <span>{t('reimb.section')}</span>
        {remainingCents(tx) > 0 && (
          <button
            data-testid="reimb-add"
            onClick={() => {
              setChosen(null);
              setPickerOpen(true);
            }}
            className="m-tap flex items-center gap-1 border-none bg-transparent text-[11px] font-semibold text-accent-deep"
          >
            <Icon name="plus" size={14} />
            {t('reimb.link')}
          </button>
        )}
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="reimb-list">
        {(linkedTxs ?? []).map((linked) => {
          const link = (tx.reimbursements ?? []).find((r) => r.txId === linked.id);
          return (
            <div key={linked.id} className="flex items-center gap-3 border-b border-line-2 px-4 py-3 last:border-0">
              <Icon name="cash-refund" size={20} color="var(--m-accent)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{cleanBankText(linked.merchant)}</span>
                <span className="block text-[11px] text-ink-4">{linked.date}</span>
              </span>
              <span className="m-num text-[14px] font-semibold text-accent-deep">
                +{fmtCents(link?.amountCents ?? 0, tx.currency, lang)}
              </span>
              <button
                aria-label={t('action.delete')}
                data-testid={`reimb-unlink-${linked.id}`}
                onClick={() => unlink(linked.id)}
                className="m-tap border-none bg-transparent text-ink-4"
              >
                <Icon name="close" size={16} />
              </button>
            </div>
          );
        })}
        {total > 0 && (
          <div className="flex items-center justify-between bg-bg-2 px-4 py-2 text-[12px] text-ink-3" data-testid="reimb-summary">
            <span>{t('reimb.of', { a: fmtCents(total, tx.currency, lang), b: fmtCents(Math.abs(tx.amountCents), tx.currency, lang) })}</span>
          </div>
        )}
        {(linkedTxs ?? []).length === 0 && total === 0 && (
          <div className="px-4 py-4 text-center text-[12px] text-ink-4">—</div>
        )}
      </div>

      {/* pick a credit tx, then confirm the amount */}
      <Sheet open={pickerOpen} onOpenChange={setPickerOpen} title={t('reimb.link')} size="tall">
        {chosen ? (
          <div className="flex flex-col gap-3 pt-1" data-testid="reimb-confirm">
            <div className="text-[14px] text-ink">{cleanBankText(chosen.merchant)}</div>
            <input
              data-testid="reimb-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder={t('reimb.amountLabel')}
              className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
            />
            <Button data-testid="reimb-save" onClick={confirm}>
              {t('action.save')}
            </Button>
          </div>
        ) : (
          <div data-testid="reimb-picker">
            {(credits ?? []).map((credit) => (
              <button
                key={credit.id}
                data-testid={`reimb-pick-${credit.id}`}
                onClick={() => choose(credit)}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left"
              >
                <Icon name="cash-plus" size={20} color="var(--m-accent)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{cleanBankText(credit.merchant)}</span>
                  <span className="block text-[11px] text-ink-4">{credit.date}</span>
                </span>
                <span className="m-num text-[14px] font-semibold text-accent-deep">
                  +{fmtCents(credit.amountCents, credit.currency, lang)}
                </span>
              </button>
            ))}
          </div>
        )}
      </Sheet>
    </>
  );
}
