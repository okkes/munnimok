import { useMemo } from 'react';
import { useLang } from '@/i18n';
import type { TxView } from '@/db/types';
import type { Period } from '@/domain/periods';
import { scopedBreakdown } from '@/domain/trends';
import { catName, useCategories } from '@/features/categories/useCategories';
import { Icon } from '@/ui/Icon';

const TOP = 6;

/**
 * The picked period by subcategory inside the card's scope (user
 * 2026-10-08, "another valuable visual"): the six largest as horizontal
 * bars with their face, amount and share, the rest folded into Other.
 * A row opens the transactions behind it.
 */
export function BreakdownView({
  graphId,
  period,
  txs,
  ids,
  fmt,
  onPickSub,
}: Readonly<{
  graphId: string;
  period: Period;
  txs: readonly TxView[];
  ids: ReadonlySet<string> | null;
  fmt: (cents: number) => string;
  onPickSub: (catId: string) => void;
}>) {
  const { t } = useLang();
  const cats = useCategories();
  const groups = useMemo(() => scopedBreakdown(txs, period, ids), [txs, period, ids]);
  const total = groups.reduce((sum, group) => sum + group.cents, 0);
  const rows = groups.slice(0, TOP);
  const rest = groups.slice(TOP).reduce((sum, group) => sum + group.cents, 0);
  const top = rows[0]?.cents ?? 1;
  const share = (cents: number) => `${Math.round((cents / Math.max(total, 1)) * 100)}%`;

  if (groups.length === 0) {
    return (
      <p className="py-6 text-center text-[12px] text-ink-4" data-testid={`trends-breakdown-${graphId}`}>
        {t('trends.txEmpty')}
      </p>
    );
  }
  return (
    <div className="flex flex-col" data-testid={`trends-breakdown-${graphId}`}>
      {rows.map(({ catId, cents }) => {
        const cat = cats.byId(catId || undefined);
        const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
        const color = cat.color ?? parent?.color ?? 'var(--m-ink-3)';
        return (
          <button
            key={catId}
            data-testid={`trends-breakdown-row-${graphId}-${catId || 'none'}`}
            onClick={() => onPickSub(catId)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-0 py-2 text-left"
          >
            <Icon name={cat.icon} size={18} color={color} />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2 text-[12px]">
                <span className="truncate text-ink">{catName(cat, t)}</span>
                <span className="m-num shrink-0 text-ink-3">
                  {fmt(cents)} · {share(cents)}
                </span>
              </span>
              <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-bg-2">
                <span className="block h-full rounded-full" style={{ width: `${(cents / top) * 100}%`, background: color }} />
              </span>
            </span>
          </button>
        );
      })}
      {rest > 0 && (
        <div className="flex items-center gap-3 py-2 text-[12px] text-ink-3" data-testid={`trends-breakdown-other-${graphId}`}>
          <Icon name="dots-horizontal" size={18} color="var(--m-ink-4)" />
          <span className="flex-1">{t('trends.other')}</span>
          <span className="m-num">
            {fmt(rest)} · {share(rest)}
          </span>
        </div>
      )}
    </div>
  );
}
