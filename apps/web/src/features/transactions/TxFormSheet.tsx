import { useEffect, useMemo, useState } from 'react';
import { useSpaceAccounts } from '@/application/transactions';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { catName, useCategories } from '@/features/categories/useCategories';
import { parseCents } from '@/lib/money';
import type { TransactionRow } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { useSheetStackLock } from '@/ui/useSheetStackLock';
import { CategoryPicker } from '@/features/categories/CategoryPicker';

interface TxFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** present = edit an existing (manual) transaction */
  tx?: TransactionRow;
}

const todayIso = () => new Date().toISOString().slice(0, 10);

/**
 * Create or edit a manual transaction. Bank-imported rows (importRef set)
 * never reach this sheet — their amount/date are the bank's truth.
 */
export function TxFormSheet({ open, onOpenChange, tx }: TxFormSheetProps) {
  const { t } = useLang();
  const { repo, spaceId } = useData();
  const cats = useCategories();
  const [amount, setAmount] = useState('');
  const [isExpense, setIsExpense] = useState(true);
  const [merchant, setMerchant] = useState('');
  const [date, setDate] = useState(todayIso());
  const [accountId, setAccountId] = useState<string | null>(null);
  const [catId, setCatId] = useState<string>(UNCATEGORIZED_ID);
  const [pickerOpen, setPickerOpen] = useState(false);
  const locked = useSheetStackLock(pickerOpen);

  const allAccounts = useSpaceAccounts();
  const accounts = useMemo(() => allAccounts?.filter((a) => !a.archived), [allAccounts]);

  // (re)fill when opened
  useEffect(() => {
    if (!open) return;
    if (tx) {
      setAmount((Math.abs(tx.amountCents) / 100).toFixed(2).replace('.', ','));
      setIsExpense(tx.amountCents < 0);
      setMerchant(tx.merchant);
      setDate(tx.date);
      setAccountId(tx.accountId);
      setCatId(tx.catId ?? UNCATEGORIZED_ID);
    } else {
      setAmount('');
      setIsExpense(true);
      setMerchant('');
      setDate(todayIso());
      setAccountId(null);
      setCatId(UNCATEGORIZED_ID);
    }
  }, [open, tx]);

  const cat = cats.byId(catId);
  const effectiveAccount = accountId ?? accounts?.[0]?.id ?? null;
  const cents = parseCents(amount);
  const valid = !!merchant.trim() && cents !== null && cents > 0 && !!effectiveAccount && !!date;

  const save = () => {
    if (!valid || !effectiveAccount || cents === null) return;
    const signed = isExpense ? -Math.abs(cents) : Math.abs(cents);
    const txType = cats.byId(catId).txTypes[0] ?? (isExpense ? 'expense' : 'income');
    void repo.upsert('transaction', spaceId, tx?.id ?? repo.newId(), {
      accountId: effectiveAccount,
      date,
      amountCents: signed,
      currency: accounts?.find((a) => a.id === effectiveAccount)?.currency ?? 'EUR',
      merchant: merchant.trim(),
      catId,
      txType,
      needsReview: 0,
    });
    onOpenChange(false);
  };

  return (
    <>
      <Sheet
        open={open}
        onOpenChange={onOpenChange}
        title={tx ? t('txform.editTitle') : t('txform.addTitle')}
        size="tall"
        locked={locked}
      >
        <div className="flex flex-col gap-3 pt-1">
          {/* direction + amount */}
          <div className="flex gap-2">
            <div className="flex overflow-hidden rounded-input border border-line">
              <button
                data-testid="txform-expense"
                onClick={() => setIsExpense(true)}
                className={`m-tap border-none px-3 text-[13px] font-medium ${isExpense ? 'bg-negative-soft text-negative' : 'bg-surface text-ink-3'}`}
              >
                −
              </button>
              <button
                data-testid="txform-income"
                onClick={() => setIsExpense(false)}
                className={`m-tap border-none px-3 text-[13px] font-medium ${isExpense ? 'bg-surface text-ink-3' : 'bg-accent-soft text-accent-deep'}`}
              >
                +
              </button>
            </div>
            <input
              data-testid="txform-amount"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder={`${t('txform.amount')} (EUR)`}
              className="h-12 min-w-0 flex-1 rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
            />
          </div>

          <input
            data-testid="txform-merchant"
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder={t('txform.merchant')}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
          />

          <input
            data-testid="txform-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="h-12 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none"
          />

          {/* account chips */}
          <div className="flex flex-wrap gap-2">
            {(accounts ?? []).map((a) => (
              <button
                key={a.id}
                data-testid={`txform-account-${a.id}`}
                onClick={() => setAccountId(a.id)}
                className={`m-tap rounded-full border px-3 py-1.5 text-[13px] ${
                  effectiveAccount === a.id
                    ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                    : 'border-line bg-surface text-ink-2'
                }`}
              >
                {a.name}
              </button>
            ))}
          </div>

          {/* category row */}
          <button
            data-testid="txform-category"
            onClick={() => setPickerOpen(true)}
            className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[15px] text-ink"
          >
            <Icon name={cat.icon} size={20} color={cat.color ?? cats.byId(cat.parentId).color} />
            <span className="flex-1">{catName(cat, t)}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>

          <Button data-testid="txform-save" onClick={save} disabled={!valid}>
            {tx ? t('action.save') : t('action.add')}
          </Button>
        </div>
      </Sheet>
      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedId={catId}
        onPick={setCatId}
        direction={isExpense ? 'debit' : 'credit'}
      />
    </>
  );
}
