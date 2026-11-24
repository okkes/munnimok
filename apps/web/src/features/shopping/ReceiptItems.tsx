import { useState } from 'react';
import { useLang } from '@/i18n';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import type { ReceiptItem } from '@/db/types';

/** #648: a sub's name alone reads as another main's often enough ("Other", "Drinks"): the main stands before it,
 *  with the sub's own icon; a main's Other is the main */
export function useCatPath(): (catId: string) => { icon: string; color: string; label: string } {
  const { t } = useLang();
  const cats = useCategories();
  return (catId) => {
    const cat = cats.byId(catId);
    const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
    const label = parent && !cat.isOther ? `${catName(parent, t)} › ${catName(cat, t)}` : catName(parent ?? cat, t);
    return { icon: cat.icon, color: cat.color ?? parent?.color ?? 'var(--m-ink-3)', label };
  };
}

export function CatPath({ catId, testId, className = '' }: Readonly<{ catId: string; testId?: string; className?: string }>) {
  const path = useCatPath()(catId);
  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`} data-testid={testId}>
      <Icon name={path.icon} size={12} color={path.color} />
      <span className="truncate">{path.label}</span>
    </span>
  );
}

// the lines of a receipt as rows: the receipt's own screen frames them, a transaction shows them inside its receipt card
export function ReceiptItems({
  items,
  currency,
  testIdPrefix = 'receipt',
  limit,
}: Readonly<{
  items: readonly ReceiptItem[];
  currency: string;
  testIdPrefix?: string;
  /** more lines than this fold behind "Show all" — a long receipt must not bury the transaction under it */
  limit?: number;
}>) {
  const { t, lang } = useLang();
  const [all, setAll] = useState(false);
  const money = (cents: number) => fmtCents(cents, currency, lang);
  const id = (suffix: string): string => `${testIdPrefix}-${suffix}`;
  const folded = !all && limit !== undefined && items.length > limit;
  const shown = folded ? items.slice(0, limit) : items;
  return (
    <>
      {shown.map((item, index) => (
        // two identical lines on one receipt are two lines: the position keeps them apart
        <div key={`${index}-${item.name}-${item.totalCents}`} className="flex items-baseline gap-2 border-b border-line-2 py-2.5 text-[13px] last:border-0">
          <span className="min-w-0 flex-1 text-ink">
            {item.name}
            {/* #567: the reader's suggestion — the transaction's own split stays the truth */}
            {item.catId && <CatPath catId={item.catId} testId={id(`item-cat-${index}`)} className="flex text-[11px] text-ink-4" />}
            {!!item.discountCents && (
              <span className="block text-[11px] text-ink-4" data-testid={id(`item-discount-${index}`)}>
                {[money(item.discountCents), item.discountLabel].filter(Boolean).join(' · ')}
              </span>
            )}
          </span>
          {item.qty !== undefined && <span className="text-[11px] text-ink-4">×{item.qty}</span>}
          <span className="m-num text-ink">{money(item.totalCents)}</span>
        </div>
      ))}
      {folded && (
        <button
          data-testid={id('items-all')}
          onClick={() => setAll(true)}
          className="m-tap flex w-full items-center justify-center gap-1 border-none bg-transparent py-2.5 text-[12px] font-medium text-accent-deep"
        >
          {t('receipt.itemsAll', { n: items.length })}
          <Icon name="chevron-down" size={14} />
        </button>
      )}
    </>
  );
}
