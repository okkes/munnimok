import { LOCALES, useLang } from '@/i18n';
import type { TransactionRow, TxSplit } from '@/db/types';
import { catName, useCategories } from '@/features/categories/useCategories';
import { orDefaultLabel, txTitle } from '@/lib/text';
import { Highlight, amountQueryFor } from './Highlight';
import { Icon } from './Icon';

/** #126: one split part standing alone in a filtered list; the split glyph says it is a piece of a larger payment */
export function TxPartRow({
  tx,
  part,
  index,
  amountText,
  onClick,
  showDate = false,
  highlight = '',
}: Readonly<{
  tx: TransactionRow;
  part: TxSplit;
  index: number;
  amountText: string;
  onClick?: () => void;
  /** lists without date group headers show it inline, like TxRow (#143) */
  showDate?: boolean;
  highlight?: string;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const partCat = cats.byId(part.catId);
  const partColor = partCat.color ?? cats.byId(partCat.parentId ?? '').color;
  const label = orDefaultLabel(part.label, `${txTitle(tx)} – ${t('split.partN', { n: index + 1 })}`);
  const positive = tx.amountCents > 0;
  return (
    <button
      data-testid={`tx-part-solo-${tx.id}-${index}`}
      onClick={onClick}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-2 py-2 text-left"
    >
      <span
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in srgb, ${partColor ?? 'var(--m-ink-4)'} 14%, transparent)` }}
      >
        <Icon name={partCat.icon} size={17} color={partColor ?? 'var(--m-ink-3)'} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5 text-[14px] font-medium text-ink">
          <span className="min-w-0 truncate">
            <Highlight text={label} query={highlight} />
          </span>
          <Icon name="call-split" size={12} color="var(--m-accent-deep)" />
        </span>
        <span className="block truncate text-[12px] text-ink-3">
          {showDate && (
            <span className="text-ink-4">
              {new Date(tx.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short' })}
              {' · '}
            </span>
          )}
          {catName(partCat, t)}
        </span>
      </span>
      {/* #139: the amount wears exactly TxRow's face */}
      <span className={`m-num text-[14px] font-semibold ${positive ? 'text-accent-deep' : 'text-ink'}`}>
        <Highlight text={amountText} query={amountQueryFor(amountText, highlight)} />
      </span>
    </button>
  );
}
