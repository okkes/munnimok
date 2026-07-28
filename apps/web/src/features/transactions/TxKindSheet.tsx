import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useSpaceAccounts } from '@/application/transactions';
import { logActivity } from '@/application/activity';
import { useData } from '@/app/data';
import { ACCOUNT_TYPES, isLiability, manualBalanceDate, typeDef } from '@/features/accounts/accountTypes';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import { TX_KINDS, kindOf } from '@/domain/txKind';
import type { TxKind } from '@/domain/txKind';
import { typeForLinkedAccount } from '@/domain/txType';
import type { AccountType, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { fmtCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Chip } from '@/ui/primitives';
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
 * The counterparty picker for transfers (user redesign): searchable like
 * the recurring/event pickers, with a quick-create door — a missing
 * savings pot or loan becomes a manual account without leaving the flow.
 * There is deliberately NO "none" row: a transfer without a counterparty
 * is unrepresentable; picking the standard kind is how a link clears.
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
  const { store, repo, spaceId } = useData();
  const allAccounts = useSpaceAccounts();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<AccountType | null>(null);
  // the FULL addition flow (bank connect / statement import / manual
  // with balance+currency), one sheet deeper — the quick-create stays
  // for the fast path (user request 2026-07-28)
  const [chooserOpen, setChooserOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setCreating(false);
    setNewName('');
    setNewType(null);
  }, [open]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (allAccounts ?? [])
      .filter((a) => a.id !== excludeAccountId && !a.archived)
      .filter((a) => !q || a.name.toLowerCase().includes(q));
  }, [allAccounts, excludeAccountId, query]);

  const choose = (account: { id: string; type: AccountType }) => {
    onChoose(account);
    onOpenChange(false);
  };

  const create = () => {
    const name = newName.trim();
    if (!name || !newType) return;
    const id = repo.newId();
    void repo.upsert('account', spaceId, id, {
      name,
      type: newType,
      source: 'manual',
      currency: space?.currency ?? 'EUR',
      balanceCents: 0,
      balanceAsOf: manualBalanceDate(),
    });
    void logActivity(store, repo, spaceId, 'accountAdd', name);
    choose({ id, type: newType });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.counterparty')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">{t('tx.counterAccountHint')}</p>
      <input
        data-testid="counter-search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setCreating(false);
        }}
        placeholder={t('tx.counterSearch')}
        className="mb-2 h-11 w-full rounded-input border border-line bg-surface px-4 text-[14px] text-ink outline-none placeholder:text-ink-4"
      />
      {!creating && (
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
                {/* what picking this account MAKES the transaction */}
                <span className="block text-[11px] text-ink-4">{t(`tx.type.${typeForLinkedAccount(account.type)}`)}</span>
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
      )}
      {/* quick-create door — ALWAYS visible (user request: reaching a
          missing account must be fast, especially now that transfers
          demand a counterparty); a typed search pre-fills the name */}
      {!creating && (
        <button
          data-testid="counter-create"
          onClick={() => {
            setNewName(query.trim());
            setCreating(true);
          }}
          className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-dashed border-line bg-transparent px-4 py-3 text-left text-[14px] font-medium text-accent-deep"
        >
          <Icon name="plus-circle-outline" size={18} />
          {query.trim() ? t('tx.counterCreate', { name: query.trim() }) : t('tx.counterNew')}
        </button>
      )}
      {!creating && (
        <button
          data-testid="counter-full-setup"
          onClick={() => setChooserOpen(true)}
          className="m-tap mt-2 flex w-full items-center gap-2 rounded-card border border-dashed border-line bg-transparent px-4 py-3 text-left text-[14px] font-medium text-ink-2"
        >
          <Icon name="bank-plus" size={18} />
          {t('tx.counterFullSetup')}
        </button>
      )}
      <AddAccountChooser
        open={chooserOpen}
        onOpenChange={setChooserOpen}
        onCreated={(account) => choose(account)}
      />
      {creating && (
        <div className="mt-2 flex flex-col gap-2" data-testid="counter-create-form">
          <input
            data-testid="counter-create-name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('acct.accountName')}
            className="h-11 w-full rounded-input border border-line bg-surface px-4 text-[14px] text-ink outline-none placeholder:text-ink-4"
          />
          <div className="m-cap px-1">{t('acct.accountType')}</div>
          <div className="flex flex-wrap gap-2">
            {ACCOUNT_TYPES.map((def) => (
              <Chip key={def.type} testId={`counter-newtype-${def.type}`} selected={newType === def.type} onClick={() => setNewType(def.type)}>
                <Icon name={def.icon} size={13} /> {t(def.labelKey)}
              </Chip>
            ))}
          </div>
          {/* new liability accounts start at zero too — the user tracks
              the real balance on the account screen afterwards */}
          {newType && isLiability(newType) && (
            <p className="px-1 text-[11px] text-ink-4">{t('tx.counterCreateLiability')}</p>
          )}
          <Button data-testid="counter-create-save" disabled={!newType || !newName.trim()} onClick={create}>
            {newName.trim() ? t('tx.counterCreate', { name: newName.trim() }) : t('tx.counterNew')}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
