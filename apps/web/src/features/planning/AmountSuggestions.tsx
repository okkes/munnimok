import type { MoneyFmt } from './SegmentSection';

export interface AmountSuggestion {
  id: string;
  label: string;
  cents: number;
}

/**
 * Amounts a form can take over with one tap (user 2026-10-07): a small label
 * over the money, instead of the old "= last period €x" chips — the same face
 * under the target field and in the funding sheet.
 */
export function AmountSuggestions({
  items,
  fmt,
  currency,
  testIdPrefix,
  onPick,
}: Readonly<{ items: readonly AmountSuggestion[]; fmt: MoneyFmt; currency: string; testIdPrefix: string; onPick: (cents: number) => void }>) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid={`${testIdPrefix}s`}>
      {items.map((item) => (
        <button
          type="button"
          key={item.id}
          data-testid={`${testIdPrefix}-${item.id}`}
          onClick={() => onPick(item.cents)}
          className="m-tap flex flex-col items-start rounded-input border border-line bg-surface px-3 py-1.5 text-left"
        >
          <span className="text-[10px] font-medium uppercase tracking-wide text-ink-4">{item.label}</span>
          <span className="m-num text-[13px] font-semibold text-ink">{fmt(item.cents, currency)}</span>
        </button>
      ))}
    </div>
  );
}
