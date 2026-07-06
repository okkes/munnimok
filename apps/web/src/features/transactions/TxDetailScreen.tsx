import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useParams } from '@tanstack/react-router';
import { CATEGORY_BY_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { CategoryPicker } from '@/features/categories/CategoryPicker';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

export function TxDetailScreen() {
  const { t, lang } = useLang();
  const { db, repo, spaceId } = useData();
  const { txId } = useParams({ strict: false }) as { txId: string };
  const [pickerOpen, setPickerOpen] = useState(false);

  const tx = useLiveQuery(() => db.transactions.get(txId), [txId]);
  const account = useLiveQuery(() => (tx ? db.accounts.get(tx.accountId) : undefined), [tx?.accountId]);

  if (!tx) return <div className="h-full" data-testid="screen-tx-detail" />;

  const cat = CATEGORY_BY_ID.get(tx.catId ?? UNCATEGORIZED_ID) ?? CATEGORY_BY_ID.get(UNCATEGORIZED_ID)!;
  const parent = cat.parentId ? CATEGORY_BY_ID.get(cat.parentId) : undefined;
  const color = cat.color ?? parent?.color ?? 'var(--m-ink-3)';

  const setCategory = (catId: string) => {
    const txType = CATEGORY_BY_ID.get(catId)?.txTypes[0] ?? tx.txType;
    void repo.upsert('transaction', spaceId, tx.id, { catId, txType, needsReview: 0 });
  };
  const saveNotes = (notes: string) => {
    if (notes !== (tx.notes ?? '')) void repo.upsert('transaction', spaceId, tx.id, { notes });
  };

  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-tx-detail">
      <AppBar
        title={tx.merchant}
        leading={
          <IconButton label={t('action.back')} testId="tx-detail-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center py-6 text-center">
          <div className="m-num text-4xl text-ink" data-testid="tx-detail-amount">
            {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
          </div>
          <div className="mt-1 text-sm text-ink-3">
            {fmtDay.format(new Date(tx.date))}
            {tx.time ? ` · ${tx.time}` : ''}
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <button
            data-testid="tx-detail-category-row"
            onClick={() => setPickerOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name={cat.icon} size={20} color={color} />
            <span className="flex-1">{t(cat.nameKey as TranslationKey)}</span>
            {tx.needsReview === 1 && (
              <span className="rounded bg-warning-soft px-1.5 py-0.5 text-[10px] font-semibold text-warning">
                {t('review.confirm')}
              </span>
            )}
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          <div className="mx-4 h-px bg-line-2" />
          <div className="flex items-center gap-3 px-4 py-3.5 text-[15px] text-ink">
            <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
            <span className="flex-1 truncate">{account?.name ?? '—'}</span>
            <span className="text-xs text-ink-4">{t(`tx.type.${tx.txType}` as TranslationKey)}</span>
          </div>
          {tx.description && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <div className="px-4 py-3.5 font-mono text-xs text-ink-3">{tx.description}</div>
            </>
          )}
        </div>

        <div className="m-cap mt-5 mb-1 px-1">{t('tx.notes')}</div>
        <textarea
          data-testid="tx-detail-notes"
          defaultValue={tx.notes ?? ''}
          onBlur={(e) => saveNotes(e.target.value)}
          placeholder={t('tx.notesPlaceholder')}
          rows={3}
          className="w-full resize-none rounded-card border border-line bg-surface px-4 py-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>

      <CategoryPicker open={pickerOpen} onOpenChange={setPickerOpen} selectedId={tx.catId} onPick={setCategory} />
    </div>
  );
}
