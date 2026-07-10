import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useSpaceTransactions, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { clampReimbursement, netAmountCents, remainingCents, totalReimbursedCents, withLink } from '@/domain/reimbursement';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** the other side of a link, one tap deep — both directions use this */
function CounterpartSheet({
  counterpart,
  linkedCents,
  currency,
  onClose,
}: Readonly<{ counterpart: SpaceTx | null; linkedCents: number; currency: string; onClose: () => void }>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  return (
    <Sheet open={counterpart !== null} onOpenChange={(open) => !open && onClose()} title={t('reimb.counterpart')} size="form">
      {counterpart && (
        <div className="flex flex-col gap-3 pt-1" data-testid="reimb-counterpart">
          <div className="rounded-card border border-line bg-surface px-4 py-3">
            <div className="truncate text-[15px] font-medium text-ink">{cleanBankText(counterpart.merchant)}</div>
            <div className="text-[12px] text-ink-4">{counterpart.date}</div>
            <div className="mt-1 flex items-baseline gap-3">
              <span className="m-num text-[18px] font-semibold text-ink">
                {fmtCents(netAmountCents(counterpart), counterpart.currency, lang, { sign: true })}
              </span>
              <span className="m-num text-[12px] text-accent-deep">
                {t('reimb.linkedFor', { amount: fmtCents(linkedCents, currency, lang) })}
              </span>
            </div>
          </div>
          <Button
            data-testid="reimb-open-counterpart"
            onClick={() => {
              onClose();
              void navigate({ to: '/transactions/$txId', params: { txId: counterpart.id } });
            }}
          >
            {t('reimb.openTx')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Reimbursement links on an expense: list + unlink, and a picker over
 * recent credit transactions with a clamped amount to link. Candidates
 * come from what the SPACE sees, so reimbursements can only ever pair
 * transactions of accounts attached to the same space (user rule).
 */
export function ReimburseSection({ tx }: { tx: SpaceTx }) {
  const { t, lang } = useLang();
  const transform = useTxTransform();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<SpaceTx | null>(null);
  const [amount, setAmount] = useState('');
  const [counterpart, setCounterpart] = useState<{ tx: SpaceTx; cents: number } | null>(null);

  const allTxs = useSpaceTransactions();
  const linkedIds = useMemo(() => (tx.reimbursements ?? []).map((r) => r.txId), [tx.reimbursements]);
  const linkedTxs = useMemo(() => allTxs?.filter((c) => linkedIds.includes(c.id)), [allTxs, linkedIds]);
  const credits = useMemo(
    () =>
      allTxs
        ?.filter((c) => c.amountCents > 0 && c.id !== tx.id && !linkedIds.includes(c.id))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 30),
    [allTxs, tx.id, linkedIds],
  );
  // the reverse direction: expenses that name THIS credit as their refund
  const reimburses = useMemo(
    () =>
      allTxs
        ?.map((expense) => ({ expense, link: (expense.reimbursements ?? []).find((r) => r.txId === tx.id) }))
        .filter((entry): entry is { expense: SpaceTx; link: { txId: string; amountCents: number } } => !!entry.link),
    [allTxs, tx.id],
  );

  // a credit that reimburses something shows its own side of the story
  if (tx.amountCents >= 0) {
    if (!reimburses?.length) return null;
    return (
      <>
        <div className="m-cap mt-5 mb-1 px-1">{t('reimb.reimburses')}</div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="reimb-reverse">
          {reimburses.map(({ expense, link }) => (
            <button
              key={expense.id}
              data-testid={`reimb-reverse-${expense.id}`}
              onClick={() => setCounterpart({ tx: expense, cents: link.amountCents })}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-4 py-3 text-left last:border-0"
            >
              <Icon name="cash-refund" size={20} color="var(--m-accent)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{cleanBankText(expense.merchant)}</span>
                <span className="block text-[11px] text-ink-4">{expense.date}</span>
              </span>
              <span className="m-num text-[14px] font-semibold text-ink">
                {fmtCents(link.amountCents, tx.currency, lang)}
              </span>
              <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
            </button>
          ))}
        </div>
        <CounterpartSheet counterpart={counterpart?.tx ?? null} linkedCents={counterpart?.cents ?? 0} currency={tx.currency} onClose={() => setCounterpart(null)} />
      </>
    );
  }
  const total = totalReimbursedCents(tx);

  const unlink = (txId: string) =>
    void transform(tx, { reimbursements: withLink(tx.reimbursements, txId, 0) });

  const choose = (credit: SpaceTx) => {
    const prefill = clampReimbursement(tx, credit.amountCents, credit.amountCents);
    setChosen(credit);
    setAmount((prefill / 100).toFixed(2).replace('.', ','));
  };

  const confirm = () => {
    if (!chosen) return;
    const cents = clampReimbursement(tx, chosen.amountCents, parseCents(amount) ?? 0);
    if (cents > 0) {
      void transform(tx, { reimbursements: withLink(tx.reimbursements, chosen.id, cents) });
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
              {/* the row itself opens the other side of the link */}
              <button
                data-testid={`reimb-row-${linked.id}`}
                onClick={() => setCounterpart({ tx: linked, cents: link?.amountCents ?? 0 })}
                className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
              >
                <Icon name="cash-refund" size={20} color="var(--m-accent)" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[14px] text-ink">{cleanBankText(linked.merchant)}</span>
                  <span className="block text-[11px] text-ink-4">{linked.date}</span>
                </span>
                <span className="m-num text-[14px] font-semibold text-accent-deep">
                  +{fmtCents(link?.amountCents ?? 0, tx.currency, lang)}
                </span>
              </button>
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

      <CounterpartSheet counterpart={counterpart?.tx ?? null} linkedCents={counterpart?.cents ?? 0} currency={tx.currency} onClose={() => setCounterpart(null)} />
    </>
  );
}
