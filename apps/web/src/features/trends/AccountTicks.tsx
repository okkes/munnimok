import { useLang } from '@/i18n';
import type { SpaceAccount } from '@/db/joined';
import type { AccountType } from '@/db/types';
import { typeDef } from '@/features/accounts/accountTypes';
import { institutionLogoUrl } from '@/features/accounts/useInstitutionLogos';
import { LIQUID_TYPES } from '@/domain/balanceBand';
import { Icon } from '@/ui/Icon';
import { Picture } from '@/ui/Picture';

/** money in hand first, then what is owed */
const TYPE_ORDER: readonly AccountType[] = ['checking', 'savings', 'cash', 'credit', 'brokerage', 'loan', 'mortgage'];

/** the accounts a graph can read: the live ones — never the shared pot, someone else's money (#152) — by kind */
export function graphAccounts(accounts: readonly SpaceAccount[]): SpaceAccount[] {
  return accounts
    .filter((account) => account.deleted === 0 && account.archived !== 1 && account.type !== 'funding')
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type));
}

/** what a new balance line starts with: the money in hand, like the built-in card — the cash wallet included (#546) */
export const liquidAccountIds = (accounts: readonly SpaceAccount[]): string[] =>
  graphAccounts(accounts)
    .filter((account) => LIQUID_TYPES.has(account.type))
    .map((account) => account.id);

/** the picked accounts in words for a card's subtitle: their names, or nothing for every account */
export function accountsText(accounts: readonly SpaceAccount[], ids: readonly string[] | null | undefined): string {
  if (!ids) return '';
  return accounts
    .filter((account) => ids.includes(account.id))
    .map((account) => account.name)
    .join(', ');
}

function Tick({ on }: Readonly<{ on: boolean }>) {
  return (
    <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md border ${on ? 'border-accent bg-accent' : 'border-line bg-transparent'}`}>
      {on && <Icon name="check" size={14} color="white" />}
    </span>
  );
}

/** the bank's logo where one exists, else the type icon in the account's colour */
function AccountFace({ account }: Readonly<{ account: SpaceAccount }>) {
  const logo = account.logo ?? institutionLogoUrl(account);
  if (logo) return <Picture src={logo} className="h-[18px] w-[18px] shrink-0 rounded object-contain" loading="lazy" />;
  return <Icon name={typeDef(account.type).icon} size={18} color={account.color ?? 'var(--m-ink-3)'} />;
}

/**
 * #531 (user: "specify which financial accounts to include"): a tick per
 * account. With `allowAll` the first row stands for every account — the
 * ones added later too — and `null` is that choice; a balance line names
 * its accounts outright.
 */
export function AccountTicks({
  accounts,
  picked,
  onChange,
  allowAll,
  testId,
}: Readonly<{
  accounts: readonly SpaceAccount[];
  picked: ReadonlySet<string> | null;
  onChange: (next: Set<string> | null) => void;
  allowAll: boolean;
  testId: string;
}>) {
  const { t } = useLang();
  const toggle = (id: string) => {
    const next = new Set(picked ?? accounts.map((account) => account.id));
    if (next.has(id)) next.delete(id);
    else next.add(id);
    // ticking the last one back in is "every account" again
    onChange(allowAll && accounts.every((account) => next.has(account.id)) ? null : next);
  };
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={testId}>
      {allowAll && (
        <button
          type="button"
          data-testid={`${testId}-all`}
          aria-pressed={picked === null}
          onClick={() => onChange(picked === null ? new Set() : null)}
          className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-3 py-2.5 text-left"
        >
          <Tick on={picked === null} />
          <Icon name="bank-outline" size={18} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] text-ink">{t('trends.allAccounts')}</span>
            <span className="block truncate text-[11px] text-ink-4">{t('trends.allAccountsSub')}</span>
          </span>
        </button>
      )}
      {accounts.map((account) => {
        const on = picked === null || picked.has(account.id);
        return (
          <button
            key={account.id}
            type="button"
            data-testid={`${testId}-${account.id}`}
            aria-pressed={on}
            onClick={() => toggle(account.id)}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-3 py-2.5 text-left last:border-0"
          >
            <Tick on={on} />
            <AccountFace account={account} />
            <span className="min-w-0 flex-1 truncate text-[14px] text-ink">{account.name}</span>
          </button>
        );
      })}
    </div>
  );
}
