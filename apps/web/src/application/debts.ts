import { useMemo } from 'react';
import { useSpaceAccounts } from './transactions';
import { visibleAccounts } from '@/db/joined';
import { isDebtTracked, loanOverpaidCents, loanProgress, loanRemainingCents, paidOffYear } from '@/domain/debts';
import { isRetiredDefault } from '@/domain/defaultAccounts';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow } from '@/db/types';

// #536: each space's own reading of the account (attachment type and name), one entry per account
// a global account is no loan until a space attaches it as one
export async function debtsMissingRate(store: StorageBackend): Promise<AccountRow[]> {
  const spaces = (await store.allRows('space')).filter((s) => s.deleted === 0 && !!s.kind);
  const found = new Map<string, AccountRow>();
  for (const space of spaces) {
    for (const account of await visibleAccounts(store, space.id)) {
      if (found.has(account.id) || account.archived === 1 || account.link?.archived === 1) continue;
      // munni's own fixture, about to be removed: nothing to ask the person about
      if (isRetiredDefault(account)) continue;
      if ((account.interestPctYear ?? undefined) === undefined && isDebtTracked(account)) found.set(account.id, account);
    }
  }
  return [...found.values()];
}

export interface LoanStatus {
  account: AccountRow;
  remainingCents: number;
  progress: number;
  /** #693: what was paid back beyond what it owed */
  overpaidCents: number;
  /** #697: the year it was marked paid off; null while open (or unknown) */
  paidOffYear: number | null;
}

export function useLoanStatuses(): LoanStatus[] | undefined {
  const accounts = useSpaceAccounts();
  return useMemo(() => {
    if (!accounts) return undefined;
    const loans = accounts.filter((a) => a.deleted === 0 && isDebtTracked(a));
    loans.sort((a, b) => (a.archived ?? 0) - (b.archived ?? 0) || a.name.localeCompare(b.name));
    return loans.map((account) => {
      const remainingCents = loanRemainingCents(account);
      return {
        account,
        remainingCents,
        progress: loanProgress(account, remainingCents),
        overpaidCents: loanOverpaidCents(account),
        paidOffYear: paidOffYear(account),
      };
    });
  }, [accounts]);
}

