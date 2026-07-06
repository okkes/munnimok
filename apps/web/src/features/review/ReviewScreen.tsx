import { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { CATEGORY_BY_ID, UNCATEGORIZED_ID } from '@/domain/categories';
import { useLang } from '@/i18n';
import type { TranslationKey } from '@/i18n';
import { useData } from '@/app/data';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { CategoryPicker } from '@/features/categories/CategoryPicker';

/**
 * Review queue: confirm the suggested category or pick a better one, one
 * transaction at a time. Confirming keeps the category and clears the flag.
 */
export function ReviewScreen() {
  const { t, lang } = useLang();
  const { db, repo, spaceId } = useData();
  const [pickerOpen, setPickerOpen] = useState(false);

  const queue = useLiveQuery(
    () =>
      db.transactions
        .where('spaceId')
        .equals(spaceId)
        .filter((tx) => tx.deleted === 0 && tx.needsReview === 1)
        .sortBy('date'),
    [spaceId],
  );

  const tx = queue?.[queue.length - 1]; // newest first

  const confirm = () => {
    if (tx) void repo.upsert('transaction', spaceId, tx.id, { needsReview: 0 });
  };
  const recategorize = (catId: string) => {
    if (!tx) return;
    const txType = CATEGORY_BY_ID.get(catId)?.txTypes[0] ?? tx.txType;
    void repo.upsert('transaction', spaceId, tx.id, { catId, txType, needsReview: 0 });
  };

  const cat = tx ? (CATEGORY_BY_ID.get(tx.catId ?? UNCATEGORIZED_ID) ?? CATEGORY_BY_ID.get(UNCATEGORIZED_ID)!) : null;
  const parent = cat?.parentId ? CATEGORY_BY_ID.get(cat.parentId) : undefined;
  const color = cat?.color ?? parent?.color ?? 'var(--m-ink-3)';

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-review">
      <AppBar
        title={t('review.title')}
        sub={queue && queue.length > 0 ? `${queue.length}` : undefined}
        leading={
          <IconButton label={t('action.back')} testId="review-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col px-5 pb-6">
        {!tx && queue && (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center" data-testid="review-empty">
            <Icon name="check-circle-outline" size={48} color="var(--m-accent)" />
            <div className="m-h3 text-ink">{t('review.noTxs')}</div>
            <p className="max-w-[260px] text-sm text-ink-3">{t('review.noTxsSub')}</p>
          </div>
        )}
        {tx && cat && (
          <>
            <div className="mt-4 flex flex-1 flex-col items-center justify-center rounded-card border border-line bg-surface px-6 py-8 text-center" data-testid="review-card">
              <div className="text-sm text-ink-3">
                {new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang === 'nl' ? 'nl-NL' : 'tr-TR', {
                  weekday: 'long',
                  day: 'numeric',
                  month: 'long',
                }).format(new Date(tx.date))}
              </div>
              <div className="m-h2 mt-2 text-ink">{tx.merchant}</div>
              <div className="m-num mt-1 text-3xl text-ink">{fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}</div>
              {tx.description && <div className="mt-2 font-mono text-xs text-ink-4">{tx.description}</div>}
              <button
                data-testid="review-category-chip"
                onClick={() => setPickerOpen(true)}
                className="m-tap mt-6 inline-flex items-center gap-2 rounded-full border border-line bg-bg px-4 py-2 text-[14px] font-medium text-ink"
              >
                <Icon name={cat.icon} size={18} color={color} />
                {t(cat.nameKey as TranslationKey)}
                <Icon name="pencil-outline" size={14} color="var(--m-ink-4)" />
              </button>
            </div>
            <div className="mt-4 flex gap-3">
              <Button variant="outline" className="flex-1" data-testid="review-change-btn" onClick={() => setPickerOpen(true)}>
                {t('action.edit')}
              </Button>
              <Button variant="primary" className="flex-1" data-testid="review-confirm-btn" onClick={confirm}>
                {t('review.confirm')}
              </Button>
            </div>
          </>
        )}
      </div>
      <CategoryPicker open={pickerOpen} onOpenChange={setPickerOpen} selectedId={tx?.catId} onPick={recategorize} />
    </div>
  );
}
