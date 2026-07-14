import { useMemo } from 'react';
import { useSpaceAccounts, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { ALL_TX_TYPES, applyTypeChange, typeForLinkedAccount } from '@/domain/txType';
import { useCategories } from '@/features/categories/useCategories';
import type { AccountType, TxType } from '@/db/types';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

const ACCOUNT_ICON: Record<AccountType, string> = {
  checking: 'bank-outline',
  savings: 'piggy-bank-outline',
  cash: 'wallet-outline',
  brokerage: 'chart-line',
  credit: 'credit-card-outline',
  mortgage: 'home-percent-outline',
  loan: 'hand-coin-outline',
};

/**
 * Counter-account + type editor, account-first (user feedback): the
 * account this money moved to or from suggests the type, so it leads —
 * as a real list with icons and balances instead of guess-the-badge.
 * The account's type is only a DEFAULT (user revision): picking a manual
 * type keeps the link but overrides the type.
 *
 * Two modes: write-through (detail screen — edits land immediately) and
 * CONTROLLED (review draft): with `value`+`onPickType`/`onPickLinked`
 * the sheet only reports choices and never writes.
 */
export function TxTypeSheet({
  open,
  onOpenChange,
  tx,
  value,
  onPickType,
  onPickLinked,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tx: SpaceTx;
  /** controlled mode: what the checkmarks reflect instead of the tx */
  value?: { txType: TxType; linkedAccountId?: string };
  onPickType?: (txType: TxType) => void;
  onPickLinked?: (account: { id: string; type: AccountType } | null) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const transform = useTxTransform();

  const allAccounts = useSpaceAccounts();
  const accounts = useMemo(() => allAccounts?.filter((a) => a.id !== tx.accountId), [allAccounts, tx.accountId]);

  const controlled = !!onPickType || !!onPickLinked;
  const current = value ?? { txType: tx.txType, linkedAccountId: tx.linkedAccountId };
  const catTxTypes = cats.byId(tx.catId).txTypes;

  const save = (nextType: TxType, linkedAccountId: string | null) => {
    const fields = applyTypeChange({ nextType, linkedAccountId, currentCatId: tx.catId, catTxTypes });
    // explicit null clears the link (undefined would be dropped by JSON)
    void transform(tx, { ...fields, linkedAccountId: linkedAccountId ?? (null as never) });
  };

  const chooseType = (type: TxType) => {
    if (controlled) onPickType?.(type);
    else save(type, tx.linkedAccountId ?? null); // the link survives a manual override
    onOpenChange(false);
  };

  const chooseLinked = (accountId: string | null) => {
    const account = accountId === null ? null : (accounts?.find((a) => a.id === accountId) ?? null);
    if (accountId !== null && !account) return;
    if (controlled) {
      onPickLinked?.(account && { id: account.id, type: account.type });
    } else if (account) {
      save(typeForLinkedAccount(account.type), account.id);
    } else {
      save(tx.txType, null);
    }
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.type')} size="tall">
      {/* the other side first — it decides the type */}
      <div className="m-cap mb-1 px-1">{t('tx.counterAccount')}</div>
      <p className="pb-2 text-[12px] text-ink-3">{t('tx.counterAccountHint')}</p>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txtype-accounts">
        <button
          data-testid="txtype-linked-none"
          onClick={() => chooseLinked(null)}
          className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
        >
          <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
          <span className="min-w-0 flex-1 text-[14px] text-ink-2">{t('tx.linkedAccountNone')}</span>
          {!current.linkedAccountId && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
        </button>
        {(accounts ?? []).map((account) => (
          <button
            key={account.id}
            data-testid={`txtype-linked-${account.id}`}
            onClick={() => chooseLinked(account.id)}
            className="m-tap flex w-full items-center gap-3 border-t border-line-2 px-4 py-3 text-left"
          >
            <Icon name={ACCOUNT_ICON[account.type] ?? 'bank-outline'} size={18} color="var(--m-ink-2)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{account.name}</span>
              <span className="block text-[11px] text-ink-4">{t(`tx.type.${typeForLinkedAccount(account.type)}`)}</span>
            </span>
            <span className="m-num text-[12px] text-ink-3">{fmtCents(account.balanceCents, account.currency, lang)}</span>
            {current.linkedAccountId === account.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
        ))}
      </div>

      <div className="m-cap mt-4 mb-1 px-1">{t('tx.typeManual')}</div>
      {!!current.linkedAccountId && (
        <p className="pb-2 text-[12px] text-ink-3" data-testid="txtype-default-note">
          {t('tx.typeDefaultFromAccount')}
        </p>
      )}
      <div className="flex flex-col" data-testid="txtype-options">
        {ALL_TX_TYPES.map((type) => (
          <button
            key={type}
            data-testid={`txtype-${type}`}
            onClick={() => chooseType(type)}
            className="m-tap flex items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left text-[14px] text-ink"
          >
            <span className="flex-1">{t(`tx.type.${type}`)}</span>
            {current.txType === type && <Icon name="check" size={18} color="var(--m-accent)" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
