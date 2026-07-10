import { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useParams } from '@tanstack/react-router';
import { useSpaceTransaction, useTxTransform } from '@/application/transactions';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { useEvents } from '@/application/events';
import { RecurringVisual } from '@/features/recurring/RecurringVisual';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { cleanBankText } from '@/lib/text';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { SplitPane } from '@/ui/SplitPane';
import { TransactionsScreen } from './TransactionsScreen';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { netAmountCents, totalReimbursedCents } from '@/domain/reimbursement';
import { ReceiptSection } from '@/features/shopping/ReceiptSection';
import { ReimburseSection } from './ReimburseSection';
import { SplitEditorSheet } from './SplitEditorSheet';
import { TxFormSheet } from './TxFormSheet';
import { TxTypeSheet } from './TxTypeSheet';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

export function TxDetailScreen() {
  const { t, lang } = useLang();
  const { db } = useData();
  const { txId } = useParams({ strict: false }) as { txId: string };
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);

  const tx = useSpaceTransaction(txId);
  const transform = useTxTransform();
  const account = useLiveQuery(() => (tx ? db.accounts.get(tx.accountId) : undefined), [tx?.accountId]);
  const cats = useCategories();
  const recurrings = useRecurrings();
  const recurringOps = useRecurringOps();
  const events = useEvents();

  if (!tx)
    return (
      <SplitPane list={<TransactionsScreen />}>
        <div className="h-full" data-testid="screen-tx-detail" />
      </SplitPane>
    );

  const cat = cats.byId(tx.catId);
  const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
  const color = cat.color ?? parent?.color ?? 'var(--m-ink-3)';

  const setCategory = (catId: string) => {
    const txType = cats.byId(catId).txTypes[0] ?? tx.txType;
    void transform(tx, { catId, txType, needsReview: 0 });
  };
  const saveNotes = (notes: string) => {
    if (notes !== (tx.notes ?? '')) void transform(tx, { notes });
  };

  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    // §4.2: at lg the transaction list stays beside the detail
    <SplitPane list={<TransactionsScreen />}>
    <div className="m-fade flex h-full flex-col" data-testid="screen-tx-detail">
      <AppBar
        title={cleanBankText(tx.merchant)}
        leading={
          <IconButton label={t('action.back')} testId="tx-detail-back" onClick={() => window.history.back()}>
            <Icon name="chevron-left" size={24} />
          </IconButton>
        }
        trailing={
          // bank-imported rows are the bank's truth — only manual txs are editable
          tx.importRef ? undefined : (
            <IconButton label={t('action.edit')} testId="tx-detail-edit" onClick={() => setEditOpen(true)}>
              <Icon name="pencil-outline" size={20} />
            </IconButton>
          )
        }
      />
      {!tx.importRef && <TxFormSheet open={editOpen} onOpenChange={setEditOpen} tx={tx} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center py-6 text-center">
          <div className="m-num text-4xl text-ink" data-testid="tx-detail-amount">
            {fmtCents(netAmountCents(tx), tx.currency, lang, { sign: true })}
          </div>
          {totalReimbursedCents(tx) > 0 && (
            <div className="m-num mt-0.5 text-sm text-ink-4 line-through" data-testid="tx-detail-gross">
              {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
            </div>
          )}
          <div className="mt-1 text-sm text-ink-3">
            {fmtDay.format(new Date(tx.date))}
            {tx.time ? ` · ${tx.time}` : ''}
          </div>
        </div>

        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center">
            <button
              data-testid="tx-detail-category-row"
              onClick={() => setPickerOpen(true)}
              className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
            >
              <Icon name={cat.icon} size={20} color={color} />
              <span className="flex-1">{catName(cat, t)}</span>
              {tx.needsReview === 1 && <Pill tone="warning">{t('tx.unreviewed')}</Pill>}
              <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
            </button>
            <button
              data-testid="tx-detail-split"
              aria-label={t('split.action')}
              onClick={() => setSplitOpen(true)}
              className="m-tap mr-3 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-none bg-bg-2 text-ink-3"
            >
              <Icon name="call-split" size={17} />
            </button>
          </div>
          {!!tx.splits?.length && (
            <div className="px-4 pb-3" data-testid="tx-detail-splits">
              {tx.splits.map((s) => {
                const sc = cats.byId(s.catId);
                return (
                  <div key={s.catId} className="flex items-center gap-2 py-1 text-[13px] text-ink-2">
                    <Icon name={sc.icon} size={15} color={sc.color ?? cats.byId(sc.parentId ?? '').color} />
                    <span className="flex-1 truncate">{catName(sc, t)}</span>
                    <span className="m-num">{fmtCents(s.amountCents, tx.currency, lang)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="tx-detail-type-row"
            onClick={() => setTypeOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
            <span className="flex-1 truncate">{account?.name ?? '—'}</span>
            <span className="text-xs text-ink-4">{t(`tx.type.${tx.txType}`)}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
          {tx.txType === 'expense' && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <button
                data-testid="tx-detail-recurring-row"
                onClick={() => setRecurringOpen(true)}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name="autorenew" size={20} color="var(--m-ink-3)" />
                <span className="flex-1 truncate">
                  {tx.recurringId
                    ? (recurrings?.find((r) => r.id === tx.recurringId)?.name ?? t('recurring.linkTitle'))
                    : t('recurring.linkTitle')}
                </span>
                {!tx.recurringId && <span className="text-xs text-ink-4">{t('recurring.linkNone')}</span>}
                <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
              </button>
            </>
          )}
          {tx.txType === 'expense' && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <button
                data-testid="tx-detail-event-row"
                onClick={() => setEventOpen(true)}
                className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
              >
                <Icon name="party-popper" size={20} color="var(--m-ink-3)" />
                <span className="flex-1 truncate">
                  {tx.eventId ? (events?.find((e) => e.id === tx.eventId)?.name ?? t('events.linkTitle')) : t('events.linkTitle')}
                </span>
                {!tx.eventId && <span className="text-xs text-ink-4">{t('events.linkNone')}</span>}
                <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
              </button>
            </>
          )}
          {tx.description && (
            <>
              <div className="mx-4 h-px bg-line-2" />
              <div className="px-4 py-3.5 font-mono text-xs text-ink-3">{cleanBankText(tx.description)}</div>
            </>
          )}
        </div>

        <ReimburseSection tx={tx} />
        <ReceiptSection tx={tx} />

        <div className="m-cap mt-5 mb-1 px-1">{t('tx.notes')}</div>
        <NotesField
          value={tx.notes ?? ''}
          onSave={saveNotes}
          placeholder={t('tx.notesPlaceholder')}
          className="w-full resize-none rounded-card border border-line bg-surface px-4 py-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>

      <CategoryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        selectedId={tx.catId}
        onPick={setCategory}
        direction={tx.amountCents < 0 ? 'debit' : 'credit'}
        txType={tx.txType}
      />
      <TxTypeSheet open={typeOpen} onOpenChange={setTypeOpen} tx={tx} />
      <SplitEditorSheet open={splitOpen} onOpenChange={setSplitOpen} tx={tx} />

      {/* attach to an event */}
      <Sheet open={eventOpen} onOpenChange={setEventOpen} title={t('events.linkTitle')} size="form">
        <div className="pt-1" data-testid="tx-event-list">
          <button
            data-testid="tx-event-none"
            onClick={() => {
              void transform(tx, { eventId: '' });
              setEventOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('events.linkNone')}</span>
            {!tx.eventId && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
          {(events ?? [])
            .filter((e) => e.archived !== 1)
            .map((e) => (
              <button
                key={e.id}
                data-testid={`tx-event-${e.id}`}
                onClick={() => {
                  void transform(tx, { eventId: e.id });
                  setEventOpen(false);
                }}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink last:border-0"
              >
                <Icon name={e.icon ?? 'party-popper'} size={18} color="var(--m-accent-deep)" />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {tx.eventId === e.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
              </button>
            ))}
        </div>
      </Sheet>

      {/* attach to a recurring cost */}
      <Sheet open={recurringOpen} onOpenChange={setRecurringOpen} title={t('recurring.linkTitle')} size="form">
        <div className="pt-1" data-testid="tx-recurring-list">
          <button
            data-testid="tx-recurring-none"
            onClick={() => {
              void recurringOps.linkTx(tx, '');
              setRecurringOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('recurring.linkNone')}</span>
            {!tx.recurringId && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
          </button>
          {(recurrings ?? [])
            .filter((r) => r.active === 1)
            .map((r) => (
              <button
                key={r.id}
                data-testid={`tx-recurring-${r.id}`}
                onClick={() => {
                  void recurringOps.linkTx(tx, r.id);
                  setRecurringOpen(false);
                }}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink last:border-0"
              >
                <RecurringVisual rec={r} size={18} active={false} />
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <span className="m-num text-[12px] text-ink-4">{fmtCents(r.amountCents, tx.currency, lang)}</span>
                {tx.recurringId === r.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
              </button>
            ))}
        </div>
      </Sheet>
    </div>
    </SplitPane>
  );
}

/**
 * Notes editor that stays live in shared spaces: remote edits replace
 * the draft whenever this user is not actively typing in the field.
 */
function NotesField({
  value,
  onSave,
  placeholder,
  className,
}: {
  value: string;
  onSave: (notes: string) => void;
  placeholder: string;
  className: string;
}) {
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (document.activeElement !== ref.current) setDraft(value);
  }, [value]);
  return (
    <textarea
      ref={ref}
      data-testid="tx-detail-notes"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onSave(draft)}
      placeholder={placeholder}
      rows={3}
      className={className}
    />
  );
}
