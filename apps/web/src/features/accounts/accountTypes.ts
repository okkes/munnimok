import type { TranslationKey } from '@/i18n';
import type { AccountType } from '@/db/types';

/** manual account types, shared by the global and space add flows; the order is the space's segment order (#550) */
export const ACCOUNT_TYPES: { type: AccountType; labelKey: TranslationKey; groupKey: TranslationKey; icon: string; liability?: boolean }[] = [
  { type: 'checking', labelKey: 'acct.bank', groupKey: 'acct.group.checking', icon: 'bank-outline' },
  { type: 'savings', labelKey: 'acct.saving', groupKey: 'acct.group.savings', icon: 'piggy-bank-outline' },
  { type: 'cash', labelKey: 'acct.cashWallet', groupKey: 'acct.group.cash', icon: 'wallet-outline' },
  { type: 'brokerage', labelKey: 'acct.brokerage', groupKey: 'acct.group.brokerage', icon: 'chart-line' },
  { type: 'credit', labelKey: 'acct.creditCard', groupKey: 'acct.group.credit', icon: 'credit-card-outline', liability: true },
  { type: 'mortgage', labelKey: 'acct.mortgage', groupKey: 'acct.group.mortgage', icon: 'home-percent-outline', liability: true },
  { type: 'loan', labelKey: 'acct.loan', groupKey: 'acct.group.loan', icon: 'hand-coin-outline', liability: true },
  // #152: a shared pot you fund: its transactions never show in the space and its balance counts nowhere
  { type: 'funding', labelKey: 'acct.funding', groupKey: 'acct.group.funding', icon: 'account-group-outline' },
];
export const typeDef = (type: AccountType) => ACCOUNT_TYPES.find((d) => d.type === type) ?? ACCOUNT_TYPES[0];
export const isLiability = (type: AccountType) => !!typeDef(type).liability;

/** #550: one segment per type in ACCOUNT_TYPES order, empty ones left out */
export function groupByAccountType<T extends { type: AccountType }>(items: readonly T[]): { type: AccountType; items: T[] }[] {
  return ACCOUNT_TYPES.map((def) => ({ type: def.type, items: items.filter((item) => typeDef(item.type).type === def.type) })).filter(
    (group) => group.items.length > 0,
  );
}

/** a manual balance is "true today": dated so a statement import can tell whether its balance is newer (importCamt) */
export const manualBalanceDate = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
