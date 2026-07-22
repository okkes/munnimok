import { useMemo } from 'react';
import { useSpaceAccounts } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { ALL_TX_TYPES, typeForLinkedAccount } from '@/domain/txType';
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

/** every type gets a face (user request: the plain list read as a wall
 * of words) — colors sit near the category palette, not the brand */
export const TX_TYPE_VISUAL: Record<TxType, { icon: string; color: string }> = {
  expense: { icon: 'cart-outline', color: '#C0392B' },
  income: { icon: 'cash-plus', color: '#27AE60' },
  saving: { icon: 'piggy-bank-outline', color: '#16A085' },
  transfer: { icon: 'swap-horizontal', color: '#2980B9' },
  debtPayment: { icon: 'hand-coin-outline', color: '#D68910' },
  investment: { icon: 'chart-line', color: '#8E44AD' },
  adjustment: { icon: 'tune-variant', color: '#7F8C8D' },
};

/** the 7 type options as a flat list — shared by the type sheet and the
 *  review category editor's stacked type picker */
export function TxTypeOptionList({ current, onPick }: Readonly<{ current: TxType; onPick: (type: TxType) => void }>) {
  const { t } = useLang();
  return (
    <div className="flex flex-col" data-testid="txtype-options">
      {ALL_TX_TYPES.map((type) => (
        <button
          key={type}
          data-testid={`txtype-${type}`}
          onClick={() => onPick(type)}
          className="m-tap flex items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left text-[14px] text-ink"
        >
          <span
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
            style={{ background: `color-mix(in srgb, ${TX_TYPE_VISUAL[type].color} 14%, transparent)` }}
          >
            <Icon name={TX_TYPE_VISUAL[type].icon} size={17} color={TX_TYPE_VISUAL[type].color} />
          </span>
          <span className="flex-1">{t(`tx.type.${type}`)}</span>
          {current === type && <Icon name="check" size={18} color="var(--m-accent)" />}
        </button>
      ))}
    </div>
  );
}

/** just the 7 types in a sheet — the type rows on detail and review */
export function TxTypeOptionsSheet({
  open,
  onOpenChange,
  current,
  onPick,
  linkedNote = false,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: TxType;
  onPick: (type: TxType) => void;
  /** a counter-account link exists: say the type is only a DEFAULT */
  linkedNote?: boolean;
}>) {
  const { t } = useLang();
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.type')} size="tall">
      {linkedNote && (
        <p className="pb-2 text-[12px] text-ink-3" data-testid="txtype-default-note">
          {t('tx.typeDefaultFromAccount')}
        </p>
      )}
      <TxTypeOptionList
        current={current}
        onPick={(type) => {
          onPick(type);
          onOpenChange(false);
        }}
      />
    </Sheet>
  );
}

/** own-accounts picker for the counterparty — chosen account (or null =
 *  no link) is reported and the sheet closes */
export function CounterAccountSheet({
  open,
  onOpenChange,
  tx,
  currentLinkedId,
  onChoose,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tx: SpaceTx;
  currentLinkedId?: string;
  onChoose: (account: { id: string; type: AccountType } | null) => void;
}>) {
  const { t, lang } = useLang();
  const allAccounts = useSpaceAccounts();
  const accounts = useMemo(() => allAccounts?.filter((a) => a.id !== tx.accountId), [allAccounts, tx.accountId]);

  const choose = (account: { id: string; type: AccountType } | null) => {
    onChoose(account);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.counterAccount')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">{t('tx.counterAccountHint')}</p>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="txtype-accounts">
        <button
          data-testid="txtype-linked-none"
          onClick={() => choose(null)}
          className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left"
        >
          <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
          <span className="min-w-0 flex-1 text-[14px] text-ink-2">{t('tx.linkedAccountNone')}</span>
          {!currentLinkedId && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
        </button>
        {(accounts ?? []).map((account) => (
          <button
            key={account.id}
            data-testid={`txtype-linked-${account.id}`}
            onClick={() => choose({ id: account.id, type: account.type })}
            className="m-tap flex w-full items-center gap-3 border-t border-line-2 px-4 py-3 text-left"
          >
            <Icon name={ACCOUNT_ICON[account.type] ?? 'bank-outline'} size={18} color="var(--m-ink-2)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] text-ink">{account.name}</span>
              <span className="block text-[11px] text-ink-4">{t(`tx.type.${typeForLinkedAccount(account.type)}`)}</span>
            </span>
            <span className="m-num text-[12px] text-ink-3">{fmtCents(account.balanceCents, account.currency, lang)}</span>
            {currentLinkedId === account.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
