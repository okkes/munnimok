import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useSpaceAccounts } from '@/application/transactions';
import { useData } from '@/app/data';
import { typeDef } from '@/features/accounts/accountTypes';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import { TX_KINDS, kindOf } from '@/domain/txKind';
import type { TxKind } from '@/domain/txKind';
import { accountStamp } from '@/domain/txType';
import type { AccountType, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/** the three choices a person actually makes (user simplification) */
export const TX_KIND_VISUAL: Record<TxKind, { icon: string; color: string }> = {
  standard: { icon: 'cash-multiple', color: '#27AE60' },
  transfer: { icon: 'swap-horizontal', color: '#2980B9' },
  adjustment: { icon: 'tune-variant', color: '#7F8C8D' },
};

/**
 * "Standard · Expense" / "Transfer · Saving": the kind carries the
 * resolved technical type along as quiet context. Plain transfers and
 * adjustments add nothing — the kind already says it all.
 */
export function kindDetail(txType: TxType): TxType | null {
  const kind = kindOf(txType);
  if (kind === 'standard') return txType;
  if (kind === 'transfer' && txType !== 'transfer') return txType;
  return null;
}

/**
 * The kind picker: three rows with a sentence each. Adjustment is a
 * manual-bookkeeping tool and only offered on hand-entered rows (user
 * rule); bank rows can never be "corrections".
 */
export function TxKindSheet({
  open,
  onOpenChange,
  current,
  allowAdjustment,
  onPick,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: TxKind;
  allowAdjustment: boolean;
  onPick: (kind: TxKind) => void;
}>) {
  const { t } = useLang();
  const kinds = TX_KINDS.filter((k) => k !== 'adjustment' || allowAdjustment);
  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.kindTitle')} size="form">
      <div className="flex flex-col" data-testid="txkind-options">
        {kinds.map((kind) => (
          <button
            key={kind}
            data-testid={`txkind-${kind}`}
            onClick={() => {
              onPick(kind);
              onOpenChange(false);
            }}
            className="m-tap flex items-start gap-3 border-none bg-transparent px-1 py-3 text-left"
          >
            <span
              className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full"
              style={{ background: `color-mix(in srgb, ${TX_KIND_VISUAL[kind].color} 14%, transparent)` }}
            >
              <Icon name={TX_KIND_VISUAL[kind].icon} size={17} color={TX_KIND_VISUAL[kind].color} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-[14px] font-medium text-ink">{t(`tx.kind.${kind}`)}</span>
              <span className="block text-[12px] leading-snug text-ink-3">{t(`tx.kind.${kind}Sub`)}</span>
            </span>
            {current === kind && <Icon name="check" size={18} color="var(--m-accent)" />}
          </button>
        ))}
      </div>
    </Sheet>
  );
}

/**
 * The counterparty picker for transfers (user redesign): the accounts
 * munni tracks plus the ONE creation door. Typed-splits v2 (R2,
 * 2026-08-05): a transfer strictly needs a tracked counter account —
 * the old "no counter account" bare-type exit retired; its stories
 * (set aside without a pot, the flat loan, funding) live on the marked
 * special CATEGORIES of standard rows now, and the hint at the bottom
 * points there.
 */
export function CounterpartySheet({
  open,
  onOpenChange,
  excludeAccountId,
  currentLinkedId,
  onChoose,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeAccountId: string;
  currentLinkedId?: string;
  onChoose: (account: { id: string; type: AccountType }) => void;
}>) {
  const { t, lang } = useLang();
  const { store, spaceId } = useData();
  const allAccounts = useSpaceAccounts();
  // the FULL creation flow (bank connect / statement import / manual),
  // one sheet deeper — search and quick-create retired (user redesign
  // 2026-08-01: the field confused, and Create covers the missing-
  // account case properly)
  const [chooserOpen, setChooserOpen] = useState(false);

  const candidates = useMemo(
    () => (allAccounts ?? []).filter((a) => a.id !== excludeAccountId && !a.archived),
    [allAccounts, excludeAccountId],
  );

  // a loan account is a DEBT's backing account (1:1, user design
  // 2026-07-28): transferring to it IS paying that debt off — the row
  // says which one, so picking the account is picking the debt
  const debts = useQuery(store, async () => (await store.bySpace('debt', spaceId)).filter((d) => d.deleted === 0), [spaceId]);
  const debtByAccount = useMemo(() => new Map((debts ?? []).filter((d) => d.accountId).map((d) => [d.accountId!, d])), [debts]);

  const choose = (account: { id: string; type: AccountType }) => {
    onChoose(account);
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.counterparty')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">{t('tx.counterAccountHint')}</p>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="counter-accounts">
          {candidates.map((account) => (
            <button
              key={account.id}
              data-testid={`counter-pick-${account.id}`}
              onClick={() => choose({ id: account.id, type: account.type })}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
            >
              <Icon name={typeDef(account.type).icon} size={18} color="var(--m-ink-2)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{account.name}</span>
                {/* what the COUNTER ledger will record (its R1 stamp) */}
                <span className="block text-[11px] text-ink-4">
                  {t(`tx.type.${accountStamp(account.type) ?? 'transfer'}`)}
                  {debtByAccount.has(account.id) && (
                    <span className="text-accent-deep" data-testid={`counter-debt-${account.id}`}>
                      {' '}· {t('tx.paysDebt', { name: debtByAccount.get(account.id)!.name })}
                    </span>
                  )}
                </span>
              </span>
              <span className="m-num text-[12px] text-ink-3">{fmtCents(account.balanceCents, account.currency, lang)}</span>
              {currentLinkedId === account.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
          ))}
          {candidates.length === 0 && (
            <p className="px-4 py-3 text-[13px] text-ink-4" data-testid="counter-empty">
              {t('tx.counterNoMatch')}
            </p>
          )}
        </div>
      {/* the ONE creation door (user redesign 2026-08-01): the full
          chooser — bank connect, statement import (in place) or manual */}
      <button
        data-testid="counter-full-setup"
        onClick={() => setChooserOpen(true)}
        className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-dashed border-line bg-transparent px-4 py-3 text-left text-[14px] font-medium text-accent-deep"
      >
        <Icon name="plus-circle-outline" size={18} />
        {t('tx.counterFullSetup')}
      </button>
      {/* R2: no bare exit anymore — the untracked stories live on the
          marked special categories of standard rows */}
      <p className="px-1 pt-2 text-[12px] leading-snug text-ink-4" data-testid="counter-special-hint">
        {t('tx.counterSpecialHint')}
      </p>
      <AddAccountChooser
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        onCreated={(account) => choose(account)}
      />
    </Sheet>
  );
}
