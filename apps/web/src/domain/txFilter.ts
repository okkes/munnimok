import type { TransactionRow, TxType } from '@/db/types';
import { cleanBankText } from '@/lib/text';

export interface TxFilter {
  /** matches merchant and bank description, case/whitespace-insensitive */
  query?: string;
  /** empty/undefined set = all accounts */
  accountIds?: ReadonlySet<string>;
  onlyNeedsReview?: boolean;
  /** category ids to match — a main category passes itself plus its subs */
  catIds?: ReadonlySet<string>;
  txTypes?: ReadonlySet<TxType>;
  /** inclusive yyyy-mm-dd bounds (overview drill-down scopes to a period) */
  from?: string;
  to?: string;
}

export function filterTxs(txs: TransactionRow[], filter: TxFilter): TransactionRow[] {
  const q = filter.query?.trim().toLowerCase();
  return txs.filter((tx) => {
    if (filter.accountIds?.size && !filter.accountIds.has(tx.accountId)) return false;
    if (filter.onlyNeedsReview && tx.needsReview !== 1) return false;
    if (filter.catIds?.size && !filter.catIds.has(tx.catId ?? '')) return false;
    if (filter.txTypes?.size && !filter.txTypes.has(tx.txType)) return false;
    if (filter.from && tx.date < filter.from) return false;
    if (filter.to && tx.date > filter.to) return false;
    if (q) {
      const haystack = `${cleanBankText(tx.merchant)} ${cleanBankText(tx.description)}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export const hasActiveFilter = (f: TxFilter): boolean =>
  Boolean(
    f.query?.trim() || f.accountIds?.size || f.onlyNeedsReview || f.catIds?.size || f.txTypes?.size || f.from || f.to,
  );
