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
  // a numeric query ('10', '10,99') also matches amounts by their digit
  // string — '10' finds 10,99 and 210,15 alike (user request)
  const amountQ = q?.replaceAll(/[\s.,€-]/g, '');
  const amountSearch = !!amountQ && /^\d+$/.test(amountQ);
  return txs.filter((tx) => {
    if (filter.accountIds?.size && !filter.accountIds.has(tx.accountId)) return false;
    if (filter.onlyNeedsReview && tx.needsReview !== 1) return false;
    if (filter.catIds?.size && !filter.catIds.has(tx.catId ?? '')) return false;
    if (filter.txTypes?.size && !filter.txTypes.has(tx.txType)) return false;
    if (filter.from && tx.date < filter.from) return false;
    if (filter.to && tx.date > filter.to) return false;
    if (q) {
      const haystack = `${cleanBankText(tx.merchant)} ${cleanBankText(tx.description)}`.toLowerCase();
      const amountHit = amountSearch && String(Math.abs(tx.amountCents)).includes(amountQ);
      if (!haystack.includes(q) && !amountHit) return false;
    }
    return true;
  });
}

export const hasActiveFilter = (f: TxFilter): boolean =>
  Boolean(
    f.query?.trim() || f.accountIds?.size || f.onlyNeedsReview || f.catIds?.size || f.txTypes?.size || f.from || f.to,
  );
