import { useState } from 'react';
import { useLang } from '@/i18n';
import { localToday } from '@/application/recurring';
import type { ReceiptRow } from '@/db/types';
import { parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Field } from '@/ui/primitives';

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const INPUT = 'h-11 w-full rounded-input border border-line bg-surface px-3 text-[14px] text-ink outline-none placeholder:text-ink-4';

/**
 * #567: what a receipt kept without a transaction says — shop, day and
 * amount, typed here or filled by a reading. The amount is what its
 * payment is recognised by, so a receipt without one waits unmatched.
 */
export function ReceiptFacts({
  receipt,
  onSave,
}: Readonly<{
  receipt: Pick<ReceiptRow, 'date' | 'totalCents' | 'merchant'>;
  onSave: (facts: { date: string; totalCents: number; merchant: string }) => Promise<void>;
}>) {
  const { t } = useLang();
  const [shop, setShop] = useState(receipt.merchant ?? '');
  const [amount, setAmount] = useState(receipt.totalCents > 0 ? toText(receipt.totalCents) : '');
  const [date, setDate] = useState(receipt.date);
  const [busy, setBusy] = useState(false);

  const cents = parseCents(amount);
  const valid = cents !== null && cents > 0 && date !== '' && date <= localToday();
  const changed = cents !== receipt.totalCents || date !== receipt.date || shop.trim() !== (receipt.merchant ?? '');

  const save = async () => {
    if (!valid || cents === null) return;
    setBusy(true);
    try {
      await onSave({ date, totalCents: cents, merchant: shop.trim() });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-card border border-line bg-surface p-3" data-testid="receipt-facts">
      <Field label={t('receipt.facts.shop')} htmlFor="receipt-facts-shop">
        <input id="receipt-facts-shop" data-testid="receipt-facts-shop" value={shop} onChange={(e) => setShop(e.target.value)} className={INPUT} />
      </Field>
      <div className="grid grid-cols-2 gap-2.5">
        <Field label={t('receipt.facts.amount')} htmlFor="receipt-facts-amount">
          <input
            id="receipt-facts-amount"
            data-testid="receipt-facts-amount"
            inputMode="decimal"
            placeholder="0,00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`${INPUT} m-num`}
          />
        </Field>
        <Field label={t('receipt.facts.date')} htmlFor="receipt-facts-date">
          <input
            id="receipt-facts-date"
            data-testid="receipt-facts-date"
            type="date"
            max={localToday()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={`${INPUT} appearance-none`}
          />
        </Field>
      </div>
      <p className="px-1 text-[11px] leading-snug text-ink-4">{t('receipt.facts.hint')}</p>
      <Button variant="outline" className="w-full" data-testid="receipt-facts-save" disabled={busy || !valid || !changed} onClick={() => void save()}>
        {t('action.save')}
      </Button>
    </div>
  );
}
