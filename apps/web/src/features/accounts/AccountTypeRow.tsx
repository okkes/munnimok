import { useState } from 'react';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { changeAccountType } from '@/application/accounts';
import { logActivity } from '@/application/activity';
import type { AccountRow, AccountType } from '@/db/types';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { ACCOUNT_TYPES, typeDef } from './accountTypes';

/**
 * #212 (user): the account TYPE, visible after creation and changeable
 * behind a destructive confirm — the type decides the stamping rules,
 * so changing it resets every transaction on the account back to
 * review with a fresh interpretation ("as if added for the first
 * time"); balances, links and pairs are physical facts and survive.
 * One row, shared by the manual editor and the feed sheet.
 */
export function AccountTypeRow({ account, readOnly }: Readonly<{ account: AccountRow; readOnly?: boolean }>) {
  const { t } = useLang();
  const { store, repo, spaceId } = useData();
  const [pickOpen, setPickOpen] = useState(false);
  const [pendingType, setPendingType] = useState<AccountType | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!pendingType || busy) return;
    setBusy(true);
    try {
      await changeAccountType(store, repo, account, pendingType);
      void logActivity(store, repo, spaceId, 'accountEdit', `${account.name} → ${t(typeDef(pendingType).labelKey)}`);
      setPendingType(null);
      setPickOpen(false);
    } finally {
      setBusy(false);
    }
  };

  // funding pots and munni's own default ledgers never change type
  const locked = readOnly || account.type === 'funding' || !!account.defaultFor;

  return (
    <>
      <button
        data-testid="account-type-row"
        disabled={locked}
        onClick={() => setPickOpen(true)}
        className="m-tap flex w-full items-center gap-3 rounded-input border border-line bg-surface px-4 py-3 text-left text-[14px] text-ink disabled:opacity-60"
      >
        <Icon name={typeDef(account.type).icon} size={20} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">{t(typeDef(account.type).labelKey)}</span>
        <span className="text-[11px] text-ink-4">{t('acct.typeRow')}</span>
        {!locked && <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />}
      </button>

      <Sheet open={pickOpen} onOpenChange={setPickOpen} title={t('acct.typeRow')} size="tall" dragHandle>
        <p className="pb-2 text-[12px] leading-relaxed text-ink-3">{t('acct.typeChangeHint')}</p>
        <div className="grid grid-cols-2 gap-2" data-testid="account-type-grid">
          {ACCOUNT_TYPES.filter((def) => def.type !== 'funding').map((def) => (
            <button
              key={def.type}
              data-testid={`account-type-pick-${def.type}`}
              onClick={() => {
                if (def.type === account.type) setPickOpen(false);
                else setPendingType(def.type);
              }}
              className={`m-tap flex flex-col items-start gap-2 rounded-card border p-4 text-left ${
                def.type === account.type ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface'
              }`}
            >
              <Icon name={def.icon} size={22} color="var(--m-accent)" />
              <span className="text-[13px] font-medium text-ink">{t(def.labelKey)}</span>
            </button>
          ))}
        </div>
      </Sheet>

      <DangerConfirmSheet
        open={pendingType !== null}
        onOpenChange={(next) => {
          if (!next) setPendingType(null);
        }}
        title={t('acct.typeChangeTitle')}
        body={t('acct.typeChangeBody', { type: pendingType ? t(typeDef(pendingType).labelKey) : '' })}
        confirmLabel={t('acct.typeChangeGo')}
        busy={busy}
        onConfirm={() => void confirm()}
        testId="account-type-confirm"
      />
    </>
  );
}
