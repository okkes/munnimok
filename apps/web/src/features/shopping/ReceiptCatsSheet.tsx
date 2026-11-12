import { useEffect, useMemo, useState } from 'react';
import { useLang } from '@/i18n';
import type { ReceiptItem, ReceiptPick } from '@/db/types';
import { receiptLines } from '@/domain/receiptCats';
import type { ReceiptLine } from '@/domain/receiptCats';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents, parseCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';

/** a line while the sheet is open: its category once it has one, and what of the transaction it stands for */
interface LineState {
  catId?: string;
  amountCents: number;
}

const seedLines = (lines: readonly ReceiptLine[], initial: readonly ReceiptPick[]): Map<number, LineState> =>
  new Map(
    lines.map((line) => {
      const pick = initial.find((p) => p.line === line.index);
      return [line.index, pick ? { catId: pick.catId, amountCents: pick.amountCents } : { amountCents: line.paidCents }];
    }),
  );

const toText = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/** what the three figures at the top say about the money still open */
const leftTone = (leftCents: number): string => {
  if (leftCents < 0) return 'text-negative';
  return leftCents === 0 ? 'text-positive' : 'text-ink';
};

/** the value a line stands for: as printed, after the discount, typed, or whatever the transaction still has open */
function ValueEditor({
  line,
  state,
  leftCents,
  currency,
  onAmount,
}: Readonly<{ line: ReceiptLine; state: LineState; leftCents: number; currency: string; onAmount: (cents: number) => void }>) {
  const { t, lang } = useLang();
  const [typed, setTyped] = useState(toText(state.amountCents));
  const set = (cents: number) => {
    setTyped(toText(cents));
    onAmount(cents);
  };
  // what the line could take without the transaction running over: its own amount plus what is open
  const fill = state.catId ? state.amountCents + leftCents : leftCents;
  return (
    <div className="flex flex-wrap items-center gap-1.5 pb-2 pl-8" data-testid={`receiptcats-values-${line.index}`}>
      {line.printedCents !== line.paidCents && (
        <>
          <Chip selected={state.amountCents === line.paidCents} onClick={() => set(line.paidCents)} testId={`receiptcats-paid-${line.index}`}>
            {t('receiptcats.paid', { amount: fmtCents(line.paidCents, currency, lang) })}
          </Chip>
          <Chip selected={state.amountCents === line.printedCents} onClick={() => set(line.printedCents)} testId={`receiptcats-printed-${line.index}`}>
            {t('receiptcats.printed', { amount: fmtCents(line.printedCents, currency, lang) })}
          </Chip>
        </>
      )}
      {fill > 0 && fill !== state.amountCents && (
        <Chip selected={false} tone="warning" onClick={() => set(fill)} testId={`receiptcats-fill-${line.index}`}>
          {t('receiptcats.fill', { amount: fmtCents(fill, currency, lang) })}
        </Chip>
      )}
      <input
        data-testid={`receiptcats-typed-${line.index}`}
        aria-label={t('receiptcats.typed')}
        inputMode="decimal"
        value={typed}
        onChange={(e) => {
          setTyped(e.target.value);
          const cents = parseCents(e.target.value);
          if (cents !== null && cents >= 0) onAmount(cents);
        }}
        className="m-num w-24 rounded-input border border-line bg-surface px-2 py-1 text-right text-[13px] text-ink"
      />
    </div>
  );
}

/**
 * #567 (user): the transaction is what gets categorised — the receipt's
 * lines are the handles. Tick lines, give them a category, and each
 * stands for a chunk of the transaction: what was paid for it after the
 * discount, what the receipt prints, or a typed amount. The sheet keeps
 * count of what the transaction still has open and never lets the lines
 * claim more than it holds (a payment partly paid back has less to file).
 */
export function ReceiptCatsSheet({
  open,
  onOpenChange,
  items,
  currency,
  netCents,
  settledCents = 0,
  restCatId,
  initial,
  suggestions,
  onApply,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: readonly ReceiptItem[] | undefined;
  currency: string;
  /** the transaction's money the lines may claim */
  netCents: number;
  /** what of the transaction was paid back — said, so the smaller amount explains itself */
  settledCents?: number;
  /** where the money no line claims stays */
  restCatId: string;
  /** the picks the sheet opens with */
  initial: readonly ReceiptPick[];
  /** by line index: the category to suggest */
  suggestions: ReadonlyMap<number, string>;
  onApply: (picks: ReceiptPick[]) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const lines = useMemo(() => receiptLines(items), [items]);
  const [states, setStates] = useState<ReadonlyMap<number, LineState>>(new Map());
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [valueFor, setValueFor] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStates(seedLines(lines, initial));
    setSelected(new Set());
    setValueFor(null);
    // deliberately only on open: the sheet owns its lines while open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stateOf = (index: number): LineState => states.get(index) ?? { amountCents: 0 };
  const patch = (indexes: Iterable<number>, change: (state: LineState) => LineState) => {
    const next = new Map(states);
    for (const index of indexes) next.set(index, change(stateOf(index)));
    setStates(next);
  };
  const toggle = (index: number) => {
    const next = new Set(selected);
    if (!next.delete(index)) next.add(index);
    setSelected(next);
  };

  const filed = lines.filter((line) => stateOf(line.index).catId);
  const placed = filed.reduce((sum, line) => sum + stateOf(line.index).amountCents, 0);
  const left = netCents - placed;
  const unfiled = lines.filter((line) => !stateOf(line.index).catId);
  const suggestible = unfiled.filter((line) => suggestions.has(line.index));
  const fmt = (cents: number) => fmtCents(cents, currency, lang);

  const apply = () => {
    onApply(
      filed
        .map((line) => ({ line: line.index, catId: stateOf(line.index).catId!, amountCents: stateOf(line.index).amountCents }))
        .filter((pick) => pick.amountCents > 0),
    );
    onOpenChange(false);
  };

  const footer =
    selected.size > 0 ? (
      <Button className="w-full" data-testid="receiptcats-categorise" onClick={() => setPicking(true)}>
        {t('receiptcats.categorise', { n: selected.size })}
      </Button>
    ) : (
      <Button className="w-full" data-testid="receiptcats-apply" disabled={left < 0 || filed.length === 0} onClick={apply}>
        {t('receiptcats.apply')}
      </Button>
    );

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange} title={t('receiptcats.title')} size="full" footer={footer}>
        <div className="flex flex-col gap-2 pt-1" data-testid="receiptcats-sheet">
          <div className="grid grid-cols-3 gap-2 rounded-card border border-line bg-surface px-3 py-2.5 text-center">
            <div>
              <div className="m-cap">{t('receiptcats.toPlace')}</div>
              <div className="m-num text-[14px] font-semibold text-ink" data-testid="receiptcats-net">
                {fmt(netCents)}
              </div>
            </div>
            <div>
              <div className="m-cap">{t('receiptcats.placed')}</div>
              <div className="m-num text-[14px] font-semibold text-ink" data-testid="receiptcats-placed">
                {fmt(placed)}
              </div>
            </div>
            <div>
              <div className="m-cap">{t('receiptcats.left')}</div>
              <div className={`m-num text-[14px] font-semibold ${leftTone(left)}`} data-testid="receiptcats-left" data-over={left < 0 ? 'true' : undefined}>
                {fmt(left)}
              </div>
            </div>
          </div>
          {settledCents > 0 && (
            <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receiptcats-settled">
              {t('receiptcats.settledNote', { settled: fmt(settledCents), net: fmt(netCents) })}
            </p>
          )}
          {left < 0 && (
            <p className="px-1 text-[12px] leading-snug text-negative" data-testid="receiptcats-over">
              {t('receiptcats.over', { amount: fmt(-left) })}
            </p>
          )}
          {left > 0 && (
            <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receiptcats-rest">
              {t('receiptcats.rest', { name: catName(cats.byId(restCatId), t) })}
            </p>
          )}
          {lines.length === 0 && (
            <p className="px-1 pt-6 text-center text-[13px] text-ink-4" data-testid="receiptcats-empty">
              {t('receiptcats.noLines')}
            </p>
          )}
          {lines.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 px-1">
              {unfiled.length > 0 && (
                <button
                  data-testid="receiptcats-select-open"
                  onClick={() => setSelected(new Set(unfiled.map((line) => line.index)))}
                  className="m-tap border-none bg-transparent p-0 text-[12px] font-medium text-accent-deep"
                >
                  {t('receiptcats.selectOpen')}
                </button>
              )}
              {suggestible.length > 0 && (
                <button
                  data-testid="receiptcats-suggest-all"
                  onClick={() => {
                    const next = new Map(states);
                    for (const line of suggestible) next.set(line.index, { ...stateOf(line.index), catId: suggestions.get(line.index) });
                    setStates(next);
                  }}
                  className="m-tap border-none bg-transparent p-0 text-[12px] font-medium text-accent-deep"
                >
                  {t('receiptcats.useSuggestions', { n: suggestible.length })}
                </button>
              )}
            </div>
          )}
          <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3">
            {lines.map((line) => {
              const state = stateOf(line.index);
              const suggestion = state.catId ? undefined : suggestions.get(line.index);
              return (
                <div key={line.index} data-testid={`receiptcats-line-${line.index}`} data-filed={state.catId ? 'true' : undefined}>
                  <div className="flex items-start gap-2 py-2.5">
                    <input
                      type="checkbox"
                      data-testid={`receiptcats-tick-${line.index}`}
                      aria-label={line.name}
                      checked={selected.has(line.index)}
                      onChange={() => toggle(line.index)}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-[var(--m-accent-deep)]"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-ink">{line.name}</div>
                      {state.catId && (
                        <span className="mt-0.5 inline-flex items-center gap-1 rounded-full bg-accent-soft py-0.5 pr-1 pl-2 text-[11px] font-medium text-accent-deep">
                          <span data-testid={`receiptcats-cat-${line.index}`}>{catName(cats.byId(state.catId), t)}</span>
                          <button
                            data-testid={`receiptcats-clear-${line.index}`}
                            aria-label={t('receiptcats.clear')}
                            onClick={() => patch([line.index], (s) => ({ amountCents: s.amountCents }))}
                            className="m-tap flex border-none bg-transparent p-0 text-accent-deep"
                          >
                            <Icon name="close" size={13} />
                          </button>
                        </span>
                      )}
                      {suggestion && (
                        <button
                          data-testid={`receiptcats-suggest-${line.index}`}
                          onClick={() => patch([line.index], (s) => ({ ...s, catId: suggestion }))}
                          className="m-tap mt-0.5 block border-none bg-transparent p-0 text-left text-[11px] font-medium text-accent-deep"
                        >
                          {t('receipt.itemCategory', { name: catName(cats.byId(suggestion), t) })}
                        </button>
                      )}
                    </div>
                    <button
                      data-testid={`receiptcats-amount-${line.index}`}
                      onClick={() => setValueFor(valueFor === line.index ? null : line.index)}
                      className="m-tap m-num flex shrink-0 items-center gap-1 border-none bg-transparent p-0 text-[13px] font-semibold text-ink"
                    >
                      {fmt(state.amountCents)}
                      <Icon name={valueFor === line.index ? 'chevron-up' : 'chevron-down'} size={14} color="var(--m-ink-4)" />
                    </button>
                  </div>
                  {valueFor === line.index && (
                    <ValueEditor
                      line={line}
                      state={state}
                      leftCents={left}
                      currency={currency}
                      onAmount={(cents) => patch([line.index], (s) => ({ ...s, amountCents: cents }))}
                    />
                  )}
                </div>
              );
            })}
          </div>
          {lines.length > 0 && filed.length === 0 && selected.size === 0 && (
            <p className="px-1 text-center text-[12px] text-ink-4" data-testid="receiptcats-hint">
              {t('receiptcats.pickFirst')}
            </p>
          )}
        </div>
      </Sheet>
      <CategoryPicker
        open={picking}
        onOpenChange={setPicking}
        direction="debit"
        noSpecials
        onPick={(catId) => {
          patch(selected, (state) => ({ ...state, catId }));
          setSelected(new Set());
          setPicking(false);
        }}
      />
    </>
  );
}
