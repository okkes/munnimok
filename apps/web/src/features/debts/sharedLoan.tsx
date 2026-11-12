import { useCanEdit, useReadOnlySpaceIds } from '@/app/useCanEdit';
import type { SpaceAccount } from '@/application/transactions';
import type { AccountRow } from '@/db/types';
import { useLang } from '@/i18n';

/** an attached account's own row lives in its owner's feed, which every other member only reads */
export function useLoanWritable(): (account: AccountRow) => boolean {
  const canEdit = useCanEdit();
  const readOnly = useReadOnlySpaceIds();
  return (account) => canEdit && !readOnly.has(account.spaceId);
}

/** whose account it is, where the space is the person's to change but this account is not */
export function OthersLoanNote({ account, testId, className = '' }: Readonly<{ account: AccountRow; testId: string; className?: string }>) {
  const { t } = useLang();
  const name = (account as SpaceAccount).link?.attachedByName;
  return (
    <p data-testid={testId} className={`text-[12px] leading-snug text-ink-3 ${className}`}>
      {name ? t('debts.sharedAccount', { name }) : t('debts.sharedAccountAnon')}
    </p>
  );
}
