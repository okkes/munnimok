import { useMemo, useState } from 'react';
import { useQuery } from '@/db/useQuery';
import { useSpaceAccounts, useSpaceTransactions } from '@/application/transactions';
import { useData } from '@/app/data';
import { typeDef } from '@/features/accounts/accountTypes';
import { AddAccountChooser } from '@/features/accounts/AddAccountChooser';
import { TX_KINDS, kindOf } from '@/domain/txKind';
import type { TxKind } from '@/domain/txKind';
import { accountStamp, typeForLinkedAccount } from '@/domain/txType';
import { counterDuplicates } from '@/domain/counterMatch';
import { FAMILY_ACCOUNT_TYPE, NAME_KEYS, defaultAccountId, ensureDefaultAccount } from '@/application/defaultAccounts';
import type { DefaultFamily } from '@/application/defaultAccounts';
import type { AccountType, TxType } from '@/db/types';
import { useLang } from '@/i18n';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';

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
 * The counterparty question (#133 step B): the accounts munni tracks
 * plus the ONE creation door — and, on a ◆ family ask, the "Default —
 * no setup" row pinned on top (minted lazily on first accept). Bank-fed
 * accounts wear a badge: picking one means Transfer, the real arriving
 * row pairs with it. Picking a MANUAL account forks — quick-create the
 * counterpart (the mint), or point at the row that is already there
 * (the pick-existing door; nothing minted, nothing moves).
 */
export function CounterpartySheet({
  open,
  onOpenChange,
  excludeAccountId,
  currentLinkedId,
  onChoose,
  defaultFamily,
  counterTypes,
  anchor,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excludeAccountId: string;
  currentLinkedId?: string;
  /** the pick — `peer` set means the user pointed at an EXISTING row on
   *  the counter account: carry it in the SAME write (no mint), and the
   *  caller pairs the reciprocal via pairWithExistingRow */
  onChoose: (account: { id: string; type: AccountType }, peer?: { txId: string }) => void;
  /** #133 B: a ◆ family ask pins the "Default — no setup" row on top */
  defaultFamily?: DefaultFamily;
  /** #133 r5: the account types this ask may offer — the asking
   *  category's side of the bijection ("Set aside" lists savings
   *  accounts only, plain Transfer only regular ones). undefined =
   *  every tracked account qualifies (the generic doors, which file
   *  the category from whatever kind gets picked). */
  counterTypes?: readonly AccountType[];
  /** #133 B: the row being linked — enables the pick-existing fork on
   *  manual counterparties */
  anchor?: { id: string; amountCents: number; date: string };
}>) {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const allAccounts = useSpaceAccounts();
  const allTxs = useSpaceTransactions();
  // the FULL creation flow (bank connect / statement import / manual),
  // one sheet deeper — search and quick-create retired (user redesign
  // 2026-08-01: the field confused, and Create covers the missing-
  // account case properly)
  const [chooserOpen, setChooserOpen] = useState(false);
  // #133 B: the manual-account fork — create the counterpart, or pick
  // the row that is already there
  const [forkFor, setForkFor] = useState<{ id: string; type: AccountType; name: string } | null>(null);

  const candidates = useMemo(
    // the family defaults never list as ordinary rows — the pinned
    // Default entry is their one face (approved design). #133 r5: an
    // asking category narrows the list to ITS account types — the
    // counterparty must make sense for the category (user rule).
    () =>
      (allAccounts ?? []).filter(
        (a) => a.id !== excludeAccountId && !a.archived && !a.defaultFor && (!counterTypes || counterTypes.includes(a.type)),
      ),
    [allAccounts, excludeAccountId, counterTypes],
  );

  // a loan account is a DEBT's backing account (1:1, user design
  // 2026-07-28): transferring to it IS paying that debt off — the row
  // says which one, so picking the account is picking the debt
  const debts = useQuery(store, async () => (await store.bySpace('debt', spaceId)).filter((d) => d.deleted === 0), [spaceId]);
  const debtByAccount = useMemo(() => new Map((debts ?? []).filter((d) => d.accountId).map((d) => [d.accountId!, d])), [debts]);

  const choose = (account: { id: string; type: AccountType }, peer?: { txId: string }) => {
    onChoose(account, peer);
    setForkFor(null);
    onOpenChange(false);
  };

  // Default — no setup: mint (idempotently) and pick in one tap
  const pickDefault = async () => {
    if (!defaultFamily) return;
    const id = await ensureDefaultAccount(store, repo, spaceId, defaultFamily);
    choose({ id, type: FAMILY_ACCOUNT_TYPE[defaultFamily] });
  };

  // a manual account with plausible existing counterparts forks; every
  // other pick chooses straight away (bank rows pair by feed, and an
  // empty account has nothing to point at)
  const tap = (account: { id: string; type: AccountType; name: string; source?: string }) => {
    const duplicates =
      anchor && account.source === 'manual' ? counterDuplicates(allTxs ?? [], account.id, anchor) : [];
    if (duplicates.length > 0) setForkFor({ id: account.id, type: account.type, name: account.name });
    else choose({ id: account.id, type: account.type });
  };

  const forkDuplicates = forkFor && anchor ? counterDuplicates(allTxs ?? [], forkFor.id, anchor) : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.counterparty')} size="form">
      <p className="pb-2 text-[12px] text-ink-3">
        {t(counterTypes?.length === 1 && counterTypes[0] === 'funding' ? 'tx.counterFundingHint' : 'tx.counterAccountHint')}
      </p>
      {/* the ◆ family ask leads with Default (#133 ruling 1) */}
      {defaultFamily && (
        <button
          data-testid="counter-default"
          onClick={() => void pickDefault()}
          className="m-tap mb-2 flex w-full items-center gap-3 rounded-card border border-accent/40 bg-accent-soft/20 px-4 py-3 text-left"
        >
          <Icon name={typeDef(FAMILY_ACCOUNT_TYPE[defaultFamily]).icon} size={18} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium text-ink">{t(NAME_KEYS[defaultFamily])}</span>
            <span className="block text-[11px] text-ink-4">{t('tx.counterDefaultSub')}</span>
          </span>
          {currentLinkedId === defaultAccountId(spaceId, defaultFamily) && (
            <Icon name="check" size={17} color="var(--m-accent-deep)" />
          )}
        </button>
      )}
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="counter-accounts">
          {candidates.map((account) => (
            <button
              key={account.id}
              data-testid={`counter-pick-${account.id}`}
              onClick={() => tap(account)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
            >
              <Icon name={typeDef(account.type).icon} size={18} color="var(--m-ink-2)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] text-ink">{account.name}</span>
                {/* what the COUNTER ledger will record (its R1 stamp;
                    #152: a funding pot records funding, not transfer) */}
                <span className="block text-[11px] text-ink-4">
                  {t(`tx.type.${accountStamp(account.type) ?? typeForLinkedAccount(account.type)}`)}
                  {debtByAccount.has(account.id) && (
                    <span className="text-accent-deep" data-testid={`counter-debt-${account.id}`}>
                      {' '}· {t('tx.paysDebt', { name: debtByAccount.get(account.id)!.name })}
                    </span>
                  )}
                </span>
              </span>
              {/* C2: a bank-fed pick means Transfer — the real arriving
                  row on the other side pairs with it */}
              {account.source !== 'manual' && <Pill tone="info">{t('tx.counterBankBadge')}</Pill>}
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
      {/* #133 B: the manual fork — the mint, or the row already there */}
      <Sheet
        open={forkFor !== null}
        onOpenChange={(next) => {
          if (!next) setForkFor(null);
        }}
        title={forkFor?.name ?? ''}
        size="form"
      >
        {forkFor && (
          <div className="flex flex-col pt-1" data-testid="counter-fork">
            <button
              data-testid="counter-fork-create"
              onClick={() => choose({ id: forkFor.id, type: forkFor.type })}
              className="m-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left"
            >
              <Icon name="plus-circle-outline" size={18} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] font-medium text-ink">{t('tx.counterForkCreate')}</span>
                <span className="block text-[11px] leading-snug text-ink-4">{t('tx.counterForkCreateSub')}</span>
              </span>
            </button>
            <div className="m-cap mt-4 mb-1 px-1">{t('tx.counterForkPickHint')}</div>
            <div className="divide-y divide-line-2 overflow-hidden rounded-card border border-line bg-surface px-3">
              {forkDuplicates.map((row) => (
                <div key={row.id} data-testid={`counter-dup-${row.id}`}>
                  <TxRow tx={row} showDate hideUnreviewed onClick={() => choose({ id: forkFor.id, type: forkFor.type }, { txId: row.id })} />
                </div>
              ))}
            </div>
          </div>
        )}
      </Sheet>
    </Sheet>
  );
}
