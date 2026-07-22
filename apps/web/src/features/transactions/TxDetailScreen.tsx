import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams } from '@tanstack/react-router';
import { useLgViewport } from '@/lib/viewport';
import { useSpaceTransaction, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { useEvents } from '@/application/events';
import { RecurringVisual } from '@/features/recurring/RecurringVisual';
import { useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { cleanBankText, humanizeBankKeys, txTitle } from '@/lib/text';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { givenCents, netAmountCents, netCreditCents, totalReimbursedCents } from '@/domain/reimbursement';
import { normalizeIban } from '@/domain/feedIds';
import { ReceiptSection } from '@/features/shopping/ReceiptSection';
import { ReimburseSection } from './ReimburseSection';
import { SplitEditorSheet } from './SplitEditorSheet';
import { TxFormSheet } from './TxFormSheet';
import { CounterAccountSheet, TxTypeOptionsSheet } from './TxTypeSheet';
import { applyTypeChange, typeForLinkedAccount } from '@/domain/txType';
import { merchantKey } from '@/domain/merchantKey';
import { TxDetailCustomizeSheet, resolveTxDetailBlocks } from './TxDetailCustomizeSheet';
import type { TxDetailBlockId } from './TxDetailCustomizeSheet';
import { TxRow } from '@/ui/TxRow';
import type { SpaceTx } from '@/application/transactions';
import type { TxType } from '@/db/types';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

/** the categories block's rows: one per slice (or the single category),
 *  every pencil opening the ONE unified split editor (review parity) */
function CategorySlices({
  tx,
  cats,
  fallbackCat,
  fallbackColor,
  onEdit,
}: Readonly<{
  tx: SpaceTx;
  cats: ReturnType<typeof useCategories>;
  fallbackCat: ReturnType<ReturnType<typeof useCategories>['byId']>;
  fallbackColor: string;
  onEdit: () => void;
}>) {
  const { t, lang } = useLang();
  return (
    <>
      {(tx.splits?.length ? tx.splits : [null]).map((slice, i) => {
        const rowCat = slice ? cats.byId(slice.catId) : fallbackCat;
        const rowColor = slice ? (rowCat.color ?? cats.byId(rowCat.parentId ?? '').color) : fallbackColor;
        const parentName = rowCat.parentId ? catName(cats.byId(rowCat.parentId), t) : t(`tx.type.${tx.txType}`);
        return (
          <button
            key={slice?.catId ?? 'single'}
            data-testid={i === 0 ? 'tx-detail-category-row' : `tx-detail-cat-${slice?.catId}`}
            onClick={onEdit}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3.5 text-left last:border-0"
          >
            <Icon name={rowCat.icon} size={20} color={rowColor ?? 'var(--m-ink-3)'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-ink">{catName(rowCat, t)}</span>
              <span className="block text-[11px] text-ink-4">{parentName}</span>
            </span>
            {i === 0 && tx.needsReview === 1 && <Pill tone="warning">{t('tx.unreviewed')}</Pill>}
            {slice && <span className="m-num text-[13px] text-ink-2">{fmtCents(slice.amountCents, tx.currency, lang)}</span>}
          </button>
        );
      })}
    </>
  );
}

/** the DETAILS block: the facts underneath the user's edits — the
 *  original amount (reimbursements shrank it), the bank's original
 *  title (renamed), and the raw bank data */
function DetailFacts({ tx, givenOut }: Readonly<{ tx: SpaceTx; givenOut: number }>) {
  const { t, lang } = useLang();
  if (!(totalReimbursedCents(tx) > 0 || givenOut > 0 || tx.titleOverride || tx.description)) return null;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('tx.detailsSection')}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-detail-facts">
        {(totalReimbursedCents(tx) > 0 || givenOut > 0) && (
          <div className="flex items-center gap-3 border-b border-line-2 px-4 py-3 text-[14px] last:border-0">
            <Icon name="cash-refund" size={18} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 text-ink-3">{t('tx.originalAmount')}</span>
            <span className="m-num text-ink" data-testid="tx-detail-original-amount">
              {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
            </span>
          </div>
        )}
        {!!tx.titleOverride && (
          <div className="flex items-center gap-3 border-b border-line-2 px-4 py-3 text-[14px] last:border-0">
            <Icon name="label-outline" size={18} color="var(--m-ink-3)" />
            <span className="shrink-0 text-ink-3">{t('tx.originalTitle')}</span>
            <span className="min-w-0 flex-1 truncate text-right text-ink" data-testid="tx-detail-original-title">
              {cleanBankText(tx.merchant)}
            </span>
          </div>
        )}
        {tx.description && (
          <div className="px-4 py-3" data-testid="tx-detail-bankdata">
            <div className="flex items-center gap-3 text-[14px]">
              <Icon name="bank-outline" size={18} color="var(--m-ink-3)" />
              <span className="text-ink-3">{t('tx.bankDetails')}</span>
            </div>
            <div className="mt-1.5 pl-[30px] font-mono text-xs break-words text-ink-3">
              {humanizeBankKeys(cleanBankText(tx.description))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** every other transaction of this merchant that still differs */
const similarTo = (allTxs: SpaceTx[] | undefined, tx: SpaceTx, differs: (item: SpaceTx) => boolean): SpaceTx[] =>
  (allTxs ?? []).filter((item) => item.id !== tx.id && merchantKey(item.merchant) === merchantKey(tx.merchant) && differs(item));

/** desktop panes get a CLOSE (leave the detail); mobile keeps history-back */
function DetailBackButton({ panes, onClose, t }: Readonly<{ panes: boolean; onClose: () => void; t: TFunc }>) {
  if (panes) {
    return (
      <IconButton label={t('action.close')} testId="tx-detail-back" onClick={onClose}>
        <Icon name="close" size={20} />
      </IconButton>
    );
  }
  return (
    <IconButton label={t('action.back')} testId="tx-detail-back" onClick={() => window.history.back()}>
      <Icon name="chevron-left" size={24} />
    </IconButton>
  );
}

/**
 * The bulk offer after a category change: the bar itself opens a
 * selection sheet (user request — see and pick the transactions instead
 * of a blind apply-all); Apply touches only the checked rows.
 */
function DetailBulkBar({
  targets,
  selected,
  onChange,
  onApply,
  onDismiss,
}: Readonly<{
  targets: SpaceTx[];
  selected: ReadonlySet<string>;
  onChange: (next: ReadonlySet<string>) => void;
  onApply: () => void;
  onDismiss: () => void;
}>) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const all = targets.length > 0 && targets.every((item) => selected.has(item.id));
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onChange(next);
  };

  return (
    <div className="border-t border-line-2 bg-accent-soft/30" data-testid="tx-detail-bulk-offer">
      <div className="flex items-center gap-3 px-4 py-2.5">
        <button
          data-testid="tx-detail-bulk-expand"
          onClick={() => setOpen(true)}
          className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
        >
          <Icon name="content-copy" size={16} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1 text-[13px] text-ink-2">{t('tx.bulkOffer', { n: selected.size })}</span>
        </button>
        <button
          data-testid="tx-detail-bulk-apply"
          onClick={onApply}
          disabled={selected.size === 0}
          className="m-tap border-none bg-transparent text-[13px] font-semibold text-accent-deep disabled:opacity-40"
        >
          {t('tx.bulkApply')}
        </button>
        <button
          data-testid="tx-detail-bulk-dismiss"
          aria-label={t('action.dismiss')}
          onClick={onDismiss}
          className="m-tap border-none bg-transparent text-ink-4"
        >
          <Icon name="close" size={16} />
        </button>
      </div>

      {/* selection sheet, same mechanics as the review bulk list */}
      <Sheet open={open} onOpenChange={setOpen} title={t('tx.bulkOffer', { n: selected.size })} height={760}>
        <div className="flex items-center justify-between pb-2">
          <span className="text-[12px] text-ink-3">{t('review.bulkCount', { n: targets.length })}</span>
          <button
            data-testid="tx-detail-bulk-select-all"
            onClick={() => onChange(all ? new Set() : new Set(targets.map((item) => item.id)))}
            className="m-tap border-none bg-transparent text-[12px] font-semibold text-accent-deep"
          >
            {all ? t('review.bulkUnselectAll') : t('review.bulkSelectAll')}
          </button>
        </div>
        {/* fixed px so the list scrolls INSIDE the sheet (sheet rules) */}
        <div className="max-h-[560px] overflow-y-auto overscroll-contain" data-testid="tx-detail-bulk-list">
          {targets.map((item) => {
            const checked = selected.has(item.id);
            return (
              <div key={item.id} className="flex items-center gap-2 border-b border-line-2 last:border-0">
                <button
                  data-testid={`tx-detail-bulk-${item.id}`}
                  aria-label={cleanBankText(item.merchant)}
                  onClick={() => toggleOne(item.id)}
                  className={`m-tap flex h-5 w-5 shrink-0 items-center justify-center rounded-md border-2 ${
                    checked ? 'border-accent bg-accent text-white' : 'border-line bg-surface'
                  }`}
                >
                  {checked && <Icon name="check" size={12} />}
                </button>
                <div className="min-w-0 flex-1">
                  <TxRow tx={item} showDate onClick={() => toggleOne(item.id)} />
                </div>
              </div>
            );
          })}
        </div>
        <button
          data-testid="tx-detail-bulk-apply-sheet"
          onClick={() => {
            setOpen(false);
            onApply();
          }}
          disabled={selected.size === 0}
          className="m-tap mt-3 w-full rounded-card border-none bg-accent py-3 text-[14px] font-semibold text-white disabled:opacity-40"
        >
          {t('tx.bulkApply')}
        </button>
      </Sheet>
    </div>
  );
}

/**
 * Rename a transaction's display title (user request). The bank's
 * merchant is shown underneath and never changes — clearing the field
 * (or typing the original) removes the override again.
 */
function RenameTitleSheet({
  open,
  onOpenChange,
  original,
  value,
  onSave,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  original: string;
  value: string;
  onSave: (title: string) => void;
}>) {
  const { t } = useLang();
  const [draft, setDraft] = useState(value);
  const last = useRef(open);
  if (open && !last.current) setDraft(value); // fresh open re-seeds
  last.current = open;

  return (
    // 'form' height: on iOS vaul lifts the sheet by the keyboard height —
    // the compact sheet rose clean off the screen (user report ss 2026-07-18)
    <Sheet open={open} onOpenChange={onOpenChange} title={t('tx.renameTitle')} size="form">
      <input
        data-testid="tx-rename-input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={original}
        className="h-11 w-full rounded-input border border-line bg-surface px-4 text-[15px] text-ink outline-none placeholder:text-ink-4"
      />
      <p className="mt-2 text-[12px] text-ink-4">{t('tx.renameOriginal', { name: original })}</p>
      <div className="mt-4 flex gap-2">
        <Button
          variant="outline"
          data-testid="tx-rename-reset"
          onClick={() => {
            onSave('');
            onOpenChange(false);
          }}
        >
          {t('tx.renameReset')}
        </Button>
        <Button
          variant="primary"
          className="min-w-0 flex-1"
          data-testid="tx-rename-save"
          onClick={() => {
            onSave(draft);
            onOpenChange(false);
          }}
        >
          {t('action.save')}
        </Button>
      </div>
    </Sheet>
  );
}

export function TxDetailScreen() {
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  const { txId } = useParams({ strict: false }) as { txId: string };
  const [editOpen, setEditOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  // title bulk (user request): renaming offers the same pick-and-apply
  // flow as categories, and the memory teaches future arrivals
  const [titleBulk, setTitleBulk] = useState<{ title: string } | null>(null);
  const [titleSelected, setTitleSelected] = useState<ReadonlySet<string>>(new Set());
  // counterparty and type each open their OWN picker (user: the combined
  // sheet surprised — tapping one showed the other's content too)
  const [counterPickOpen, setCounterPickOpen] = useState(false);
  const [typePickOpen, setTypePickOpen] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [bulkOffer, setBulkOffer] = useState<{ catId: string; txType: TxType; count: number } | null>(null);
  // which of the similar transactions the bulk apply will touch (user
  // request: see and pick them, not a blind apply-all)
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const navigate = useNavigate();
  const panes = useLgViewport();

  // desktop affordance (D5): Esc closes the detail pane back to the plain
  // list — but only when no sheet is open (sheets own their own Esc)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('dialog[open], [role="dialog"]')) return;
      void navigate({ to: '/transactions' });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);

  const tx = useSpaceTransaction(txId);
  const transform = useTxTransform();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const account = useQuery(store, async () => (tx ? store.get('account', tx.accountId) : undefined), [tx?.accountId]);
  const linkedAccount = useQuery(
    store,
    async () => (tx?.linkedAccountId ? store.get('account', tx.linkedAccountId) : undefined),
    [tx?.linkedAccountId],
  );
  // read-time join (user request): the moment an account with this IBAN
  // exists locally — e.g. it was attached to a space later — every
  // transaction's counterparty upgrades from plain text to a live door
  const counterIban = tx?.counterIban ? normalizeIban(tx.counterIban) : undefined;
  const counterAccount = useQuery(
    store,
    async () =>
      counterIban
        ? (await store.allRows('account')).find((a) => a.deleted === 0 && !!a.iban && normalizeIban(a.iban) === counterIban)
        : undefined,
    [counterIban],
  );
  const cats = useCategories();
  const recurrings = useRecurrings();
  const recurringOps = useRecurringOps();
  const events = useEvents();
  // what this credit refunded elsewhere — the expenses own the links,
  // so the credit's net worth is a derived fact
  const allTxs = useSpaceTransactions();
  const givenOut = tx && tx.amountCents > 0 ? givenCents(allTxs ?? [], tx.id) : 0;

  if (!tx)
    return <div className="h-full" data-testid="screen-tx-detail" />;

  const cat = cats.byId(tx.catId);
  const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
  const color = cat.color ?? parent?.color ?? 'var(--m-ink-3)';

  const setCategory = (catId: string) => {
    const txType = cats.byId(catId).txTypes[0] ?? tx.txType;
    void transform(tx, { catId, txType, needsReview: 0 });
    // bulk mechanism from the detail too (user request) — unlike review
    // it reaches EVERYTHING of this merchant, reviewed included
    const similar = similarTo(allTxs, tx, (item) => item.catId !== catId);
    setBulkOffer(similar.length > 0 ? { catId, txType, count: similar.length } : null);
    setBulkSelected(new Set(similar.map((item) => item.id)));
  };

  const bulkTargets = bulkOffer ? similarTo(allTxs, tx, (item) => item.catId !== bulkOffer.catId) : [];

  /** rename: '' clears the override (LWW needs the explicit value) */
  const renameTitle = (raw: string) => {
    const title = raw.trim();
    const next = title && title !== cleanBankText(tx.merchant) ? title : '';
    void transform(tx, { titleOverride: next });
    const similar = similarTo(allTxs, tx, (item) => (item.titleOverride ?? '') !== next);
    setTitleBulk(next && similar.length > 0 ? { title: next } : null);
    setTitleSelected(new Set(similar.map((item) => item.id)));
  };

  const titleTargets = titleBulk ? similarTo(allTxs, tx, (item) => (item.titleOverride ?? '') !== titleBulk.title) : [];

  const applyTitleBulk = async () => {
    if (!titleBulk) return;
    for (const item of titleTargets.filter((target) => titleSelected.has(target.id))) {
      await transform(item, { titleOverride: titleBulk.title });
    }
    setTitleBulk(null);
  };

  const applyBulk = async () => {
    if (!bulkOffer) return;
    for (const item of bulkTargets.filter((target) => bulkSelected.has(target.id))) {
      await transform(item, { catId: bulkOffer.catId, txType: bulkOffer.txType, needsReview: 0 });
    }
    setBulkOffer(null);
  };
  const saveNotes = (notes: string) => {
    if (notes === (tx.notes ?? '')) return;
    void transform(tx, { notes });
    void logActivity(store, repo, spaceId, 'note', txTitle(tx));
  };

  // two-tap confirm, matching the app's other destructive rows
  const deleteManualTx = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // manual accounts keep a LIVE balance: deleting the row hands its
    // amount back (bank-linked balances stay the bank's)
    if (account && account.source !== 'gocardless') {
      await repo.upsert('account', tx.spaceId, account.id, { balanceCents: account.balanceCents - tx.amountCents });
    }
    await repo.remove('transaction', tx.spaceId, tx.id);
    void navigate({ to: '/transactions' });
  };

  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-tx-detail">
      <AppBar
        title={txTitle(tx)}
        leading={
          <DetailBackButton panes={panes} onClose={() => void navigate({ to: '/transactions', replace: true })} t={t} />
        }
        trailing={
          // manual rows edit everything via the form; bank rows are the
          // bank's truth — but the display TITLE is the user's (rename)
          tx.importRef ? (
            <IconButton label={t('tx.renameTitle')} testId="tx-detail-rename" onClick={() => setRenameOpen(true)}>
              <Icon name="pencil-outline" size={20} />
            </IconButton>
          ) : (
            <IconButton label={t('action.edit')} testId="tx-detail-edit" onClick={() => setEditOpen(true)}>
              <Icon name="pencil-outline" size={20} />
            </IconButton>
          )
        }
      />
      {!tx.importRef && <TxFormSheet open={editOpen} onOpenChange={setEditOpen} tx={tx} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <div className="flex flex-col items-center py-6 text-center">
          {/* both directions show the net truth: expenses minus what came
              back, credits minus what they refunded elsewhere */}
          <div className="m-num text-4xl text-ink" data-testid="tx-detail-amount">
            {fmtCents(
              tx.amountCents > 0 ? netCreditCents(tx, givenOut) : netAmountCents(tx),
              tx.currency, lang, { sign: true },
            )}
          </div>
          <div className="mt-1 text-sm text-ink-3">
            {fmtDay.format(new Date(tx.date))}
            {tx.time ? ` · ${tx.time}` : ''}
          </div>
          {tx.pending === 1 && (
            <div className="mt-2" data-testid="tx-detail-pending">
              <Pill tone="warning">{t('tx.pendingBadge')}</Pill>
            </div>
          )}
        </div>

        {/* title bulk: right under the header so a rename's reach is
            the first thing on screen */}
        {titleBulk && (
          <div className="mb-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-detail-title-bulk">
            <DetailBulkBar
              targets={titleTargets}
              selected={titleSelected}
              onChange={setTitleSelected}
              onApply={() => void applyTitleBulk()}
              onDismiss={() => setTitleBulk(null)}
            />
          </div>
        )}

        {/* block: account · type · counterparty */}
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center gap-3 px-4 py-3.5 text-[15px] text-ink" data-testid="tx-detail-account-row">
            <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{account?.name ?? '—'}</span>
              {linkedAccount && (
                <span className="block truncate text-[11px] text-ink-4" data-testid="tx-detail-linked-account">
                  → {linkedAccount.name}
                </span>
              )}
            </span>
            <span className="text-xs text-ink-4">{t('txform.account')}</span>
          </div>
          <div className="mx-4 h-px bg-line-2" />
          <CounterpartyRow
            counterIban={tx.counterIban}
            counterAccountName={counterAccount?.name}
            linkedAccountName={linkedAccount?.name}
            onOpenAccount={() => setCounterOpen(true)}
            onEdit={() => setCounterPickOpen(true)}
          />
          <div className="mx-4 h-px bg-line-2" />
          <button
            data-testid="tx-detail-type-row"
            onClick={() => setTypePickOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="swap-vertical" size={20} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate">{t(`tx.type.${tx.txType}`)}</span>
            <span className="text-xs text-ink-4">{t('tx.type')}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
        </div>

        {/* block: categories — ONE edit affordance for the whole block
            (user: a pencil per slice read wrong); rows stay tappable */}
        <div className="m-cap mt-5 mb-1 flex items-center justify-between px-1">
          <span>{t('screen.categories')}</span>
          <button
            data-testid="tx-detail-cats-edit"
            aria-label={t('action.edit')}
            onClick={() => setSplitOpen(true)}
            className="m-tap flex items-center gap-1 border-none bg-transparent text-[11px] font-semibold text-accent-deep"
          >
            <Icon name="pencil-outline" size={13} />
            {t('action.edit')}
          </button>
        </div>
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-detail-categories">
          <CategorySlices tx={tx} cats={cats} fallbackCat={cat} fallbackColor={color} onEdit={() => setSplitOpen(true)} />
          {bulkOffer && (
            <DetailBulkBar
              targets={bulkTargets}
              selected={bulkSelected}
              onChange={setBulkSelected}
              onApply={() => void applyBulk()}
              onDismiss={() => setBulkOffer(null)}
            />
          )}
        </div>

        {/* block: actions — recurring + event links */}
        {tx.txType === 'expense' && (
          <>
            <div className="m-cap mt-5 mb-1 px-1">{t('tx.actionsSection')}</div>
            <div className="overflow-hidden rounded-card border border-line bg-surface">
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
            </div>
          </>
        )}

        {/* block: details — the facts underneath the user's edits */}
        <DetailFacts tx={tx} givenOut={givenOut} />

        {/* the sections below the details card follow the space's saved
            order/visibility (user request — same mechanics as Home) */}
        {resolveTxDetailBlocks(space)
          .filter((entry) => !entry.hidden)
          .map((entry) => {
            const section: Record<TxDetailBlockId, ReactNode> = {
              reimburse: <ReimburseSection tx={tx} />,
              receipts: <ReceiptSection tx={tx} />,
              notes: (
                <>
                  <div className="m-cap mt-5 mb-1 px-1">{t('tx.notes')}</div>
                  <NotesField
                    value={tx.notes ?? ''}
                    onSave={saveNotes}
                    placeholder={t('tx.notesPlaceholder')}
                    className="w-full resize-none rounded-card border border-line bg-surface px-4 py-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
                  />
                </>
              ),
            };
            return <div key={entry.id}>{section[entry.id]}</div>;
          })}

        <button
          data-testid="tx-detail-customize"
          onClick={() => setCustomizeOpen(true)}
          className="m-tap mt-5 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line bg-transparent py-2.5 text-[13px] font-medium text-ink-3"
        >
          <Icon name="tune-variant" size={16} />
          {t('tx.customize')}
        </button>

        {/* manual rows may leave again (user request); bank rows are the
            bank's truth and only ever tombstone via their feed */}
        {!tx.importRef && !tx.feedSpaceId && (
          <button
            data-testid="tx-detail-delete"
            onClick={() => void deleteManualTx()}
            className="m-tap mt-6 w-full rounded-card border border-line bg-surface px-4 py-3 text-center text-[14px] font-medium text-negative"
          >
            {confirmDelete ? t('tx.deleteManualConfirm') : t('tx.deleteManual')}
          </button>
        )}
      </div>

      {/* write-through, split into two direct pickers (user report):
          the counterparty row shows accounts, the type row shows types */}
      <CounterAccountSheet
        open={counterPickOpen}
        onOpenChange={setCounterPickOpen}
        tx={tx}
        currentLinkedId={tx.linkedAccountId}
        onChoose={(picked) => {
          const nextType = picked ? typeForLinkedAccount(picked.type) : tx.txType;
          const fields = applyTypeChange({
            nextType,
            linkedAccountId: picked?.id ?? null,
            currentCatId: tx.catId,
            catTxTypes: cats.byId(tx.catId).txTypes,
          });
          // explicit null clears the link (undefined would be dropped by JSON)
          void transform(tx, { ...fields, linkedAccountId: picked?.id ?? (null as never) });
        }}
      />
      <TxTypeOptionsSheet
        open={typePickOpen}
        onOpenChange={setTypePickOpen}
        current={tx.txType}
        linkedNote={!!tx.linkedAccountId}
        onPick={(nextType: TxType) => {
          const fields = applyTypeChange({
            nextType,
            linkedAccountId: tx.linkedAccountId ?? null,
            currentCatId: tx.catId,
            catTxTypes: cats.byId(tx.catId).txTypes,
          });
          void transform(tx, fields); // the link survives a manual override
        }}
      />
      {/* ONE category flow (review parity): a single row edits the plain
          category through setCategory (which arms the bulk offer);
          added rows store a split write-through */}
      <SplitEditorSheet open={splitOpen} onOpenChange={setSplitOpen} tx={tx} seedSingle onApplySingle={setCategory} />
      <RenameTitleSheet
        open={renameOpen}
        onOpenChange={setRenameOpen}
        original={cleanBankText(tx.merchant)}
        value={txTitle(tx)}
        onSave={renameTitle}
      />
      <TxDetailCustomizeSheet open={customizeOpen} onOpenChange={setCustomizeOpen} space={space} />

      {/* the counterparty is one of the user's own accounts — show it */}
      <Sheet open={counterOpen && !!counterAccount} onOpenChange={setCounterOpen} title={counterAccount?.name ?? ''} size="compact">
        {counterAccount && (
          <div className="flex flex-col pt-1" data-testid="counterparty-sheet">
            <div className="flex items-center justify-between border-b border-line-2 px-1 py-3 text-[14px]">
              <span className="text-ink-3">{t('tx.counterparty')}</span>
              <span className="font-mono text-[13px] text-ink">{counterAccount.iban}</span>
            </div>
            <div className="flex items-center justify-between border-b border-line-2 px-1 py-3 text-[14px]">
              <span className="text-ink-3">{t('acct.balanceNow')}</span>
              <span className="m-num text-ink">{fmtCents(counterAccount.balanceCents, counterAccount.currency, lang)}</span>
            </div>
            <div className="flex items-center justify-between px-1 py-3 text-[14px]">
              <span className="text-ink-3">{t('tx.counterpartySource')}</span>
              <span className="text-ink">{t(counterAccount.source === 'manual' ? 'acct.manual' : 'acct.automated')}</span>
            </div>
          </div>
        )}
      </Sheet>

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
}: Readonly<{
  value: string;
  onSave: (notes: string) => void;
  placeholder: string;
  className: string;
}>) {
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

/** the counterparty row: a live door when the IBAN matches an own
 * account, otherwise EDITABLE (user remark: CAMT rows often ship
 * without one — picking an own account still works and suggests the
 * type through the same sheet as the type row) */
function CounterpartyRow({
  counterIban,
  counterAccountName,
  linkedAccountName,
  onOpenAccount,
  onEdit,
}: Readonly<{
  counterIban?: string;
  counterAccountName?: string;
  linkedAccountName?: string;
  onOpenAccount: () => void;
  onEdit: () => void;
}>) {
  const { t } = useLang();
  const matched = !!counterAccountName;
  const primary = counterAccountName ?? linkedAccountName;
  return (
    <button
      data-testid={matched ? 'tx-detail-counterparty-row' : 'tx-detail-counterparty-edit'}
      onClick={matched ? onOpenAccount : onEdit}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
    >
      <Icon name="swap-horizontal" size={20} color={primary ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
      <span className="min-w-0 flex-1">
        {primary ? (
          <span className="block truncate">{primary}</span>
        ) : (
          <span className="block truncate text-ink-3" data-testid="tx-detail-counter-add">
            {counterIban ?? t('tx.counterAccountPick')}
          </span>
        )}
        {counterIban && primary && (
          <span className="block truncate font-mono text-[11px] text-ink-4">{counterIban}</span>
        )}
      </span>
      <span className="text-xs text-ink-4">{t('tx.counterparty')}</span>
      <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
    </button>
  );
}
