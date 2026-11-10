import { useMemo } from 'react';
import { useSpaceAccounts } from './transactions';
import { visibleAccounts } from '@/db/joined';
import { isDebtTracked, loanProgress, loanRemainingCents } from '@/domain/debts';
import { isRetiredDefault } from '@/domain/defaultAccounts';
import type { StorageBackend } from '@/db/backend';
import type { AccountRow } from '@/db/types';

/**
 * #536 (user): the debts some live space HOLDS without an interest rate —
 * each space's own reading of the account (an attachment's type and name),
 * one entry per account. A global account is no loan until a space attaches
 * it as one, so it never asks.
 */
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

