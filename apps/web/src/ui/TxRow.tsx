import { useLang } from '@/i18n';
import { fmtCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import type { TransactionRow } from '@/db/types';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Highlight } from './Highlight';
import { Icon } from './Icon';

export function TxRow({ tx, onClick, highlight = '' }: { tx: TransactionRow; onClick?: () => void; highlight?: string }) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const cat = cats.byId(tx.catId);
  const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
  const color = cat.color ?? parent?.color ?? 'var(--m-ink-3)';
  const positive = tx.amountCents > 0;

  return (
    <button
      onClick={onClick}
      data-testid={`tx-row-${tx.id}`}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left"
    >
      <span
        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        style={{ background: `color-mix(in srgb, ${color} 14%, transparent)`, color }}
      >
        <Icon name={cat.icon} size={20} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[14px] font-medium text-ink">
          <Highlight text={cleanBankText(tx.merchant)} query={highlight} />
        </span>
        <span className="block truncate text-xs text-ink-3">
          {catName(cat, t)}
          {tx.needsReview === 1 && (
            <span className="ml-1.5 rounded bg-warning-soft px-1 py-px text-[10px] font-semibold text-warning">
              {t('review.confirm')}
            </span>
          )}
        </span>
      </span>
      <span className={`m-num shrink-0 text-[14px] font-semibold ${positive ? 'text-accent-deep' : 'text-ink'}`}>
        {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
      </span>
    </button>
  );
}
