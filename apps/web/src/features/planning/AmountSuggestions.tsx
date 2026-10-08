import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';
import type { MoneyFmt } from './SegmentSection';

export interface AmountSuggestion {
  id: string;
  label: string;
  cents: number;
}

/**
 * Amounts a form can take over with one tap: a small label over the money,
 * the same face under the target field and in the funding sheet. They read
 * as buttons (user 2026-10-08: "it's not clear those are interactable, or
 * what they do") — a caption says what a tap does, an arrow leads each chip,
 * and the chip whose amount the field already holds lights up, so the
 * effect of a tap is visible.
 */
export function AmountSuggestions({
  items,
  fmt,
  currency,
  testIdPrefix,
  selectedCents = null,
  onPick,
}: Readonly<{
  items: readonly AmountSuggestion[];
  fmt: MoneyFmt;
  currency: string;
  testIdPrefix: string;
  /** what the field holds now: the chip with that amount wears the pressed state */
  selectedCents?: number | null;
  onPick: (cents: number) => void;
}>) {
  const { t } = useLang();
  if (items.length === 0) return null;
  return (
    <div data-testid={`${testIdPrefix}s`}>
      <p className="mb-1.5 px-1 text-[11px] text-ink-4" data-testid={`${testIdPrefix}s-hint`}>
        {t('plan.suggestions.hint')}
      </p>
      <div className="flex flex-wrap gap-2">
        {items.map((item) => {
          const pressed = selectedCents !== null && item.cents === selectedCents;
          return (
            <button
              type="button"
              key={item.id}
              data-testid={`${testIdPrefix}-${item.id}`}
              aria-pressed={pressed}
              onClick={() => onPick(item.cents)}
              className={`m-tap flex items-center gap-2 rounded-input border px-3 py-1.5 text-left ${
                pressed ? 'border-accent bg-accent-soft' : 'border-line bg-surface'
              }`}
            >
              <Icon name="arrow-up-left" size={14} color={pressed ? 'var(--m-accent-deep)' : 'var(--m-ink-4)'} />
              <span className="flex flex-col items-start">
                <span className={`text-[10px] font-medium uppercase tracking-wide ${pressed ? 'text-accent-deep' : 'text-ink-4'}`}>{item.label}</span>
                <span className={`m-num text-[13px] font-semibold ${pressed ? 'text-accent-deep' : 'text-ink'}`}>{fmt(item.cents, currency)}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
