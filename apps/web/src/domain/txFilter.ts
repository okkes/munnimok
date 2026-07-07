import type { TransactionRow } from '@/db/types';
import { cleanBankText } from '@/lib/text';

export interface TxFilter {
  /** matches merchant and bank description, case/whitespace-insensitive */
  query?: string;
  accountId?: string;
  onlyNeedsReview?: boolean;
}

export function filterTxs(txs: TransactionRow[], filter: TxFilter): TransactionRow[] {
  const q = filter.query?.trim().toLowerCase();
  return txs.filter((tx) => {
    if (filter.accountId && tx.accountId !== filter.accountId) return false;
    if (filter.onlyNeedsReview && tx.needsReview !== 1) return false;
    if (q) {
      const haystack = `${cleanBankText(tx.merchant)} ${cleanBankText(tx.description)}`.toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

export const hasActiveFilter = (f: TxFilter): boolean =>
  Boolean(f.query?.trim() || f.accountId || f.onlyNeedsReview);
