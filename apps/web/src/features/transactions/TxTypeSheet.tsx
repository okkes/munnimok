import { useMemo } from 'react';
import { useSpaceAccounts, useTxTransform } from '@/application/transactions';
import type { SpaceTx } from '@/application/transactions';
import { useLang } from '@/i18n';
import { ALL_TX_TYPES, applyTypeChange, typeForLinkedAccount } from '@/domain/txType';
import { useCategories } from '@/features/categories/useCategories';
import type { TxType } from '@/db/types';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * Type + counter-account editor. Linking a counter-account derives the
 * type from what that account is (savings -> saving, credit -> debt
 * payment, ...) and locks manual choice; conflicting categories fall back
 * to uncategorized and are flagged for review.
 */
export function TxTypeSheet({ open, onOpenChange, tx }: { open: boolean; onOpenChange: (open: boolean) => void; tx: SpaceTx }) {
  const { t } = useLang();
  const cats = useCategories();
  const transform = useTxTransform();

  const allAccounts = useSpaceAccounts();
  const accounts = useMemo(() => allAccounts?.filter((a) => a.id !== tx.accountId), [allAccounts, tx.accountId]);

  const locked = !!tx.linkedAccountId;
  const catTxTypes = cats.byId(tx.catId).txTypes;

  const save = (nextType: TxType, linkedAccountId: string | null) => {
    const fields = applyTypeChange({ nextType, linkedAccountId, currentCatId: tx.catId, catTxTypes });
    // explicit null clears the link (undefined would be dropped by JSON)
    void transform(tx, { ...fields, linkedAccountId: linkedAccountId ?? (null as never) });
  };

  const chooseType = (type: TxType) => {
    if (locked) return;
    save(type, null);
    onOpenChange(false);
  };

  const chooseLinked = (accountId: string | null) => {
    if (accountId === null) {
      save(tx.txType, null);
    } else {
      const account = accounts?.find((a) => a.id === accountId);
      if (!account) return;
      save(typeForLinkedAccount(account.type), accountId);
    }
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.type')} size="tall">
      {locked && (
        <p className="pb-2 text-[12px] text-ink-3" data-testid="txtype-locked-note">
          {t('tx.typeLockedByAccount')}
        </p>
      )}
      <div className="flex flex-col" data-testid="txtype-options">
        {ALL_TX_TYPES.map((type) => (
          <button
            key={type}
            data-testid={`txtype-${type}`}
            disabled={locked}
            onClick={() => chooseType(type)}
            className="m-tap flex items-center gap-3 border-none bg-transparent px-1 py-2.5 text-left text-[14px] text-ink disabled:opacity-40"
          >
            <span className="flex-1">{t(`tx.type.${type}`)}</span>
            {tx.txType === type && <Icon name="check" size={18} color="var(--m-accent)" />}
          </button>
        ))}
      </div>

      <div className="m-cap mt-4 mb-1 px-1">{t('tx.linkedAccount')}</div>
      <div className="flex flex-wrap gap-2 pb-2">
        <button
          data-testid="txtype-linked-none"
          onClick={() => chooseLinked(null)}
          className={`m-tap rounded-full border px-3 py-1.5 text-[12px] ${
            tx.linkedAccountId ? 'border-line bg-surface text-ink-2' : 'border-accent bg-accent-soft font-medium text-accent-deep'
          }`}
        >
          {t('tx.linkedAccountNone')}
        </button>
        {(accounts ?? []).map((a) => (
          <button
            key={a.id}
            data-testid={`txtype-linked-${a.id}`}
            onClick={() => chooseLinked(a.id)}
            className={`m-tap rounded-full border px-3 py-1.5 text-[12px] ${
              tx.linkedAccountId === a.id
                ? 'border-accent bg-accent-soft font-medium text-accent-deep'
                : 'border-line bg-surface text-ink-2'
            }`}
          >
            {a.name}
          </button>
        ))}
      </div>
    </Sheet>
  );
}
