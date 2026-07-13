import { useEffect, useState } from 'react';
import { useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { fmtCents, parseCents } from '@/lib/money';
import { balanceLastRow, pctRemainder, primaryCatId, resolveSplitsFor, splitRemainderCents, splitsArePct, validatePctSplits, validateSplits } from '@/domain/splits';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import type { TxSplit } from '@/db/types';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
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
const toPctText = (pct: number) => String(pct).replace('.', ',');
const parsePct = (text: string): number => {
  const n = Number.parseFloat(text.replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** Editor partitioning a transaction across categories — in euros (must
 *  sum exactly) or percentages (must reach 100, scales to any amount). */
export function SplitEditorSheet({ open, onOpenChange, tx }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; tx: SpaceTx }>) {
  const { t, lang } = useLang();
  const transform = useTxTransform();
  const cats = useCategories();
  const [rows, setRows] = useState<Row[]>([]);
  const [mode, setMode] = useState<'amount' | 'pct'>('amount');
  const [pickerFor, setPickerFor] = useState<number | null>(null);
  // focusing an amount empties it so typing replaces instead of appending
  // (user request); blurring an untouched empty field restores the value
  const [focusStash, setFocusStash] = useState<{ index: number; amount: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    if (tx.splits?.length) {
      const pctMode = splitsArePct(tx.splits);
      setMode(pctMode ? 'pct' : 'amount');
      setRows(tx.splits.map((s) => newRow(s.catId, pctMode ? toPctText(s.pct!) : toText(s.amountCents))));
    } else {
      setMode('amount');
      // start from the current category + an empty second row
      setRows([newRow(tx.catId ?? UNCATEGORIZED_ID, toText(Math.abs(tx.amountCents))), newRow(UNCATEGORIZED_ID, '0,00')]);
    }
  }, [open, tx]);

  const splits: TxSplit[] =
    mode === 'pct'
      ? rows.map((r) => ({ catId: r.catId, amountCents: 0, pct: parsePct(r.amount) }))
      : rows.map((r) => ({ catId: r.catId, amountCents: parseCents(r.amount) ?? 0 }));
  const remainder = mode === 'pct' ? pctRemainder(splits) : splitRemainderCents(tx.amountCents, splits);
  const error = mode === 'pct' ? validatePctSplits(splits) : validateSplits(tx.amountCents, splits);

  const switchMode = (next: 'amount' | 'pct') => {
    if (next === mode) return;
    setMode(next);
    const abs = Math.abs(tx.amountCents);
    if (next === 'pct') {
      // carry the current euro shape over as rounded percentages
      setRows((r) =>
        r.map((row) => {
          const cents = parseCents(row.amount) ?? 0;
          return { ...row, amount: abs > 0 ? toPctText(Math.round((cents / abs) * 100)) : '0' };
        }),
      );
    } else {
      setRows((r) => r.map((row) => ({ ...row, amount: toText(Math.round((abs * parsePct(row.amount)) / 100)) })));
    }
  };

  const save = () => {
    if (error) return;
    // pct splits keep their percentages AND a materialized partition, so
    // every reader (budgets, drills, exports) stays simple.
    // needsReview is NOT touched: saving a split mid-review must keep the
    // card on screen until the user confirms (user request)
    const stored = mode === 'pct' ? resolveSplitsFor(tx.amountCents, splits) : splits;
    void transform(tx, {
      splits: stored,
      catId: primaryCatId(stored),
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

  const autoBalance = () => {
    if (mode === 'pct') {
      setRows((r) => {
        const open = 100 - r.slice(0, -1).reduce((sum, row) => sum + parsePct(row.amount), 0);
        return r.map((row, i) => (i === r.length - 1 ? { ...row, amount: toPctText(Math.max(0, open)) } : row));
      });
      return;
    }
    setRows((r) => {
      const abs = r.map((row) => ({ catId: row.catId, amountCents: parseCents(row.amount) ?? 0 }));
      return balanceLastRow(tx.amountCents, abs).map((s, i) => ({ ...r[i], catId: s.catId, amount: toText(s.amountCents) }));
    });
  };

  const setRowAmount = (index: number, amount: string) =>
    setRows((r) => r.map((x, j) => (j === index ? { ...x, amount } : x)));
  const removeRow = (index: number) => setRows((r) => r.filter((_, j) => j !== index));
  const addRow = () => setRows((r) => [...r, newRow(UNCATEGORIZED_ID, '0,00')]);

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('split.title')} size="tall">
        <div className="flex flex-col gap-2 pt-1" data-testid="split-editor">
          {/* exact euros for one charge, percentages when the shape repeats */}
          <div className="flex gap-1.5">
            <Chip className="flex-1" testId="split-mode-amount" selected={mode === 'amount'} onClick={() => switchMode('amount')}>
              {t('split.modeAmount')}
            </Chip>
            <Chip className="flex-1" testId="split-mode-pct" selected={mode === 'pct'} onClick={() => switchMode('pct')}>
              {t('split.modePct')}
            </Chip>
          </div>
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
                onFocus={() => {
                  setFocusStash({ index: i, amount: row.amount });
                  setRowAmount(i, '');
                }}
                onBlur={() => {
                  // left empty = the user clicked away — bring the value back
                  if (focusStash?.index === i && rows[i]?.amount.trim() === '') setRowAmount(i, focusStash.amount);
                  setFocusStash(null);
                }}
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
                ? t('split.remaining', { amount: mode === 'pct' ? `${remainder}%` : fmtCents(remainder, tx.currency, lang) })
                : t('split.over', { amount: mode === 'pct' ? `${-remainder}%` : fmtCents(-remainder, tx.currency, lang) })}
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
        txType={tx.txType}
        selectedId={pickerFor === null ? undefined : rows[pickerFor]?.catId}
        onPick={(catId) => {
          if (pickerFor !== null) setRows((r) => r.map((x, j) => (j === pickerFor ? { ...x, catId } : x)));
        }}
      />
    </>
  );
}
