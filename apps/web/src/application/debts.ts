import { useMemo } from 'react';
import { useSpaceAccounts } from './transactions';
import { isDebtTracked, loanProgress, loanRemainingCents } from '@/domain/debts';
import type { AccountRow } from '@/db/types';

export interface LoanStatus {
  account: AccountRow;
  remainingCents: number;
  progress: number;
}

/** the space's tracked liability accounts joined with their live story —
 *  active first, archived (paid off) trailing */
export function useLoanStatuses(): LoanStatus[] | undefined {
  const accounts = useSpaceAccounts();
  return useMemo(() => {
    if (!accounts) return undefined;
    const loans = accounts.filter((a) => a.deleted === 0 && isDebtTracked(a));
    loans.sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0) || a.name.localeCompare(b.name));
    return loans.map((account) => {
      const remainingCents = loanRemainingCents(account);
      return { account, remainingCents, progress: loanProgress(account, remainingCents) };
    });
  }, [accounts]);
}

