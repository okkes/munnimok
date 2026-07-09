import { useEffect, useState } from 'react';
import { useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { balanceLastRow, primaryCatId, splitRemainderCents, validateSplits } from '@/domain/splits';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import type { TxSplit } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

interface Row {
  /** stable key for React list rendering (rows have no natural id) */
  key: string;
  catId: string;
  amount: string; // user-facing text, EU decimals
}

let rowCounter = 0;
const newRow = (catId: string, amount: string): Row => ({ key: `r${rowCounter++}`, catId, amount });

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');
const toSplits = (rows: Row[]): TxSplit[] => rows.map((r) => ({ catId: r.catId, amountCents: parseCents(r.amount) ?? 0 }));

/** Editor partitioning a transaction across categories (must sum exactly). */
export function SplitEditorSheet({ open, onOpenChange, tx }: { open: boolean; onOpenChange: (open: boolean) => void; tx: SpaceTx }) {
  const { t, lang } = useLang();
  const transform = useTxTransform();
  const cats = useCategories();
  const [rows, setRows] = useState<Row[]>([]);
  const [pickerFor, setPickerFor] = useState<number | null>(null);

  useEffect(() => {
    if (!open) return;
    if (tx.splits?.length) {
      setRows(tx.splits.map((s) => newRow(s.catId, toText(s.amountCents))));
    } else {
      // start from the current category + an empty second row
      setRows([newRow(tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(tx.amountCents))), newRow(UNCATEGORIZED_ID, '0,00')]);
    }
  }, [open, tx]);

  const splits = toSplits(rows);
  const remainder = splitRemainderCents(tx.amountCents, splits);
  const error = validateSplits(tx.amountCents, splits);

  const save = () => {
    if (error) return;
    void transform(tx, {
      splits,
      catId: primaryCatId(splits),
      needsReview: 0,
    });
    onOpenChange(false);
  };

  const clearSplit = () => {
    void transform(tx, {
      splits: null as never, // explicit null clears the field
      catId: primaryCatId(splits) ?? tx.catId,
    });
    onOpenChange(false);
  };

  const autoBalance = () =>
    setRows((r) =>
      balanceLastRow(tx.amountCents, toSplits(r)).map((s, i) => ({ ...r[i], catId: s.catId, amount: toText(s.amountCents) })),
    );

  const setRowAmount = (index: number, amount: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, amount } : x)));
  const removeRow = (index: number) => setRows((r) => r.filter((_, j) => j !== index));
  const addRow = () => setRows((r) => [...r, newRow(UNCATEGORIZED_ID, '0,00')]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('split.title')} size="tall">
        <div className="flex flex-col gap-2 pt-1" data-testid="split-editor">
          {rows.map((row, i) => (
            <div key={row.key} className="flex items-center gap-2">
              <button
                data-testid={`split-cat-${i}`}
                onClick={() => setPickerFor(i)}
                className="m-tap flex h-11 min-w-0 flex-1 items-center gap-2 rounded-input border border-line bg-surface px-3 text-left text-[14px] text-ink"
              >
                <Icon name={cats.byId(row.catId).icon} size={17} color={cats.byId(cats.byId(row.catId).parentId ?? '').color ?? cats.byId(row.catId).color} />
                <span className="truncate">{catName(cats.byId(row.catId), t)}</span>
              </button>
              <input
                data-testid={`split-amount-${i}`}
                value={row.amount}
                onChange={(e) => setRowAmount(i, e.target.value)}
                inputMode="decimal"
                className="h-11 w-24 rounded-input border border-line bg-surface px-3 text-right text-[14px] text-ink outline-none"
              />
              {rows.length > 2 && (
                <button
                  aria-label={t('action.delete')}
                  data-testid={`split-remove-${i}`}
                  onClick={() => removeRow(i)}
                  className="m-tap border-none bg-transparent text-ink-4"
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </div>
          ))}

          <button
            data-testid="split-add-row"
            onClick={addRow}
            className="m-tap flex items-center gap-1.5 border-none bg-transparent px-1 py-1 text-[13px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={16} />
            {t('split.addRow')}
          </button>

          {remainder !== 0 && (
            <button
              data-testid="split-remainder"
              onClick={autoBalance}
              className={`m-tap rounded-card border-none px-3 py-2 text-left text-[13px] ${
                remainder > 0 ? 'bg-warning-soft text-warning' : 'bg-negative-soft text-negative'
              }`}
            >
              {remainder > 0
                ? t('split.remaining', { amount: fmtCents(remainder, tx.currency, lang) })
                : t('split.over', { amount: fmtCents(-remainder, tx.currency, lang) })}
            </button>
          )}

          <Button data-testid="split-save" onClick={save} disabled={!!error}>
            {t('action.save')}
          </Button>
          {!!tx.splits?.length && (
            <Button variant="outline" data-testid="split-clear" onClick={clearSplit}>
              {t('split.clear')}
            </Button>
          )}
        </div>
      </Sheet>
      <CategoryPicker
        open={pickerFor !== null}
        onOpenChange={(next) => {
          if (!next) setPickerFor(null);
        }}
        direction={tx.amountCents < 0 ? 'debit' : 'credit'}
        selectedId={pickerFor === null ? undefined : rows[pickerFor]?.catId}
        onPick={(catId) => {
          if (pickerFor !== null) setRows((r) => r.map((x, j) => (j === pickerFor ? { ...x, catId } : x)));
        }}
      />
    </>
  );
}
