import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useLgViewport } from '@/lib/viewport';
import { useSpaceAccounts, useSpaceTransaction, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { RecurringFormSheet, formFromTx } from '@/features/recurring/RecurringFormSheet';
import { EventFormSheet } from '@/features/events/EventsScreen';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { useEvents } from '@/application/events';
import { RecurringVisual } from '@/features/recurring/RecurringVisual';
import { useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { countPreAnchorTx } from '@/application/loanBalance';
import { isLiability } from '@/features/accounts/accountTypes';
import { catName, useCategories } from '@/features/categories/useCategories';
import { CategoryPicker } from '@/features/categories/CategoryPicker';
import { fmtCents } from '@/lib/money';
import { cleanBankText, humanizeBankKeys, txTitle } from '@/lib/text';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet } from '@/ui/Sheet';
import { givenCents, netAmountCents, netCreditCents, totalReimbursedCents } from '@/domain/reimbursement';
import { EXPECTED_REIMBURSE_ID, REIMBURSED_ID, UNCATEGORIZED_ID, autoSubFor, specialCatType } from '@/domain/categories';
import { primaryCatId } from '@/domain/splits';
import { ReviewPartDeck } from '@/features/review/ReviewScreen';
import { LoanPickSheet } from '@/features/debts/LoanPickSheet';
import { mirrorTxId, normalizeIban } from '@/domain/feedIds';
import { ReceiptSection } from '@/features/shopping/ReceiptSection';
import { ReimburseSection } from './ReimburseSection';
import { SplitEditorSheet } from './SplitEditorSheet';
import { PartCatsSheet, catsPatch } from './PartCatsSheet';
import { TxFormSheet } from './TxFormSheet';
import { CounterpartySheet, TX_KIND_VISUAL, TxKindSheet, kindDetail } from './TxKindSheet';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { kindOf, standardTypeFor } from '@/domain/txKind';
import type { TxKind } from '@/domain/txKind';
import { conflictingPartKinds, hasTypedParts } from '@/domain/txSlices';
import { mintMirrorForExistingLink, removeMirrorForDeletedSource } from '@/application/mirrorMint';
import { visibleTransactions, writeTxTransform } from '@/db/joined';
import { accountStamp, applyTypeChange, typeForLinkedAccount } from '@/domain/txType';
import { merchantKey } from '@/domain/merchantKey';
import { resolveTxDetailBlocks } from './TxDetailCustomizeScreen';
import type { TxDetailBlockId } from './TxDetailCustomizeScreen';
import { TxRow } from '@/ui/TxRow';
import type { SpaceTx } from '@/application/transactions';
import type { AccountRow, TxSplit, TxType } from '@/db/types';

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
  const parts = tx.splits?.length ? tx.splits : [null];
  // v2.1: only a real part story (labels/kinds/spreads) earns the spine
  // presentation — plain multi-category keeps the classic slice list
  const spine = parts.length > 1 && hasTypedParts(tx);
  return (
    <div className={spine ? "relative pl-4 before:absolute before:top-5 before:bottom-5 before:left-[7px] before:w-[2px] before:rounded-full before:bg-line before:content-['']" : ''}>
      {parts.map((slice, i) => {
        const rowCat = slice ? cats.byId(slice.catId) : fallbackCat;
        const rowColor = slice ? (rowCat.color ?? cats.byId(rowCat.parentId ?? '').color) : fallbackColor;
        const parentName = rowCat.parentId ? catName(cats.byId(rowCat.parentId), t) : t(`tx.type.${tx.txType}`);
        // typed-splits v2: the part wears its OWN story — the copied-info
        // label ("<title> – split N" unless renamed) and, when its type
        // differs from the row's kind, a quiet type chip
        const partLabel = slice?.label ?? (spine ? `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}` : undefined);
        const partType = slice?.txType && slice.txType !== tx.txType ? slice.txType : undefined;
        // a spread part's subline lists ALL its categories (v2.1)
        const spreadNames = slice?.cats?.length
          ? slice.cats.map((c) => catName(cats.byId(c.catId), t)).join(' · ')
          : undefined;
        return (
          <button
            key={slice?.id ?? slice?.catId ?? 'single'}
            data-testid={i === 0 ? 'tx-detail-category-row' : `tx-detail-cat-${slice?.catId}`}
            onClick={onEdit}
            className="m-tap relative flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3.5 text-left last:border-0"
          >
            {spine && (
              <span
                className="absolute top-1/2 -left-[13px] h-2 w-2 -translate-y-1/2 rounded-full border-2 bg-surface"
                style={{ borderColor: rowColor ?? 'var(--m-ink-4)' }}
              />
            )}
            <Icon name={rowCat.icon} size={20} color={rowColor ?? 'var(--m-ink-3)'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-ink">{spine ? partLabel : catName(rowCat, t)}</span>
              <span className="block truncate text-[11px] text-ink-4">
                {spine ? (spreadNames ?? catName(rowCat, t)) : parentName}
                {partType && (
                  <span className="text-accent-deep" data-testid={`tx-detail-part-type-${slice?.id ?? i}`}>
                    {' '}· {t(`tx.type.${partType}`)}
                  </span>
                )}
              </span>
            </span>
            {i === 0 && tx.needsReview === 1 && <Pill tone="warning">{t('tx.unreviewed')}</Pill>}
            {slice && <span className="m-num text-[13px] text-ink-2">{fmtCents(slice.amountCents, tx.currency, lang)}</span>}
          </button>
        );
      })}
    </div>
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
            <div className="mt-1.5 pl-[30px] font-mono text-xs break-words text-ink-3 select-text">
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

/** pre-anchor payment on a manual loan that was never counted in — the
 *  deliberate one-shot override applies (loans v2). `<=` mirrors the
 *  strictly-newer rule in countsTowardLoan. A peer only disqualifies
 *  when it is a REAL other leg (bank twin, picked row — its own write
 *  already carried the value); the row's own gated MINT moved nothing
 *  for pre-anchor dates, so the offer stays. */
const offersLoanCount = (
  tx: Pick<SpaceTx, 'id' | 'transferPeerId' | 'loanCounted' | 'date'>,
  linked: Pick<AccountRow, 'source' | 'type' | 'balanceAsOf'>,
): boolean =>
  linked.source === 'manual' &&
  isLiability(linked.type) &&
  (!tx.transferPeerId || tx.transferPeerId === mirrorTxId(tx.id)) &&
  tx.loanCounted !== 1 &&
  !!linked.balanceAsOf &&
  tx.date <= linked.balanceAsOf;

/** deleting a manual row (S3776: out of the screen): its mint goes with
 *  it — the manual counter's mirror is tombstoned and the balance it
 *  moved comes back (typed-splits v2) — and the row's own manual account
 *  hands the amount back (bank-linked balances stay the bank's) */
async function deleteManualTxRow(
  store: ReturnType<typeof useData>['store'],
  repo: ReturnType<typeof useData>['repo'],
  spaceId: string,
  tx: SpaceTx,
  account: AccountRow | undefined,
): Promise<void> {
  await removeMirrorForDeletedSource(store, repo, tx, tx.linkedAccountId).catch(() => undefined);
  if (account && account.source !== 'gocardless') {
    const fresh = await store.get('account', account.id);
    if (fresh?.deleted === 0) {
      await repo.upsert('account', tx.spaceId, fresh.id, { balanceCents: fresh.balanceCents - tx.amountCents });
    }
  }
  await repo.remove('transaction', tx.spaceId, tx.id);
  void logActivity(store, repo, spaceId, 'txDelete', txTitle(tx));
}

/** the create-counter heal door (S3776: out of the screen): mint the
 *  manual counter's missing leg for a pre-engine link, then peer to it */
async function healMissingMirror(
  store: ReturnType<typeof useData>['store'],
  repo: ReturnType<typeof useData>['repo'],
  tx: SpaceTx,
): Promise<void> {
  const mid = await mintMirrorForExistingLink(store, repo, tx, tx.linkedAccountId, tx.transferPeerId);
  if (mid) await writeTxTransform(repo, tx, { transferPeerId: mid });
}

/** kind before counterparty (user simplification): WHAT it is, then WHO
 *  the other side is. R1: a stamped account types every one of its rows
 *  — the row locks there (S3776: out of the screen) */
function DetailKindRow({
  kind,
  detailType,
  locked,
  onOpen,
}: Readonly<{ kind: TxKind; detailType: TxType | null; locked: boolean; onOpen: () => void }>) {
  const { t } = useLang();
  return (
    <button
      data-testid="tx-detail-kind-row"
      onClick={locked ? undefined : onOpen}
      className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
    >
      <Icon name={TX_KIND_VISUAL[kind].icon} size={20} color={TX_KIND_VISUAL[kind].color} />
      <span className="min-w-0 flex-1 truncate">
        {t(`tx.kind.${kind}`)}
        {detailType && <span className="text-[12px] text-ink-4"> · {t(`tx.type.${detailType}`)}</span>}
      </span>
      <span className="text-xs text-ink-4">{t('tx.kindTitle')}</span>
      <Icon name={locked ? 'lock-outline' : 'chevron-right'} size={locked ? 14 : 18} color="var(--m-ink-4)" />
    </button>
  );
}

/** where this transfer stands with its other leg (arc 1 pair UX) */
function transferPairState(
  tx: Pick<SpaceTx, 'txType' | 'linkedAccountId' | 'transferPeerId'>,
  linkedAccount: { source: string } | undefined,
): 'peered' | 'awaiting' | 'offerCreate' | null {
  if (kindOf(tx.txType) !== 'transfer' || !tx.linkedAccountId) return null;
  if (tx.transferPeerId) return 'peered';
  if (!linkedAccount) return null;
  // manual counter: the other side can be created right here; a feed
  // counter's real row arrives with the bank — the matcher claims it
  return linkedAccount.source === 'manual' ? 'offerCreate' : 'awaiting';
}

/** the pair row: jump to the other leg, or release the link */
function TransferPeerRow({ t, onOpen, onUnpair }: Readonly<{ t: TFunc; onOpen: () => void; onUnpair: () => void }>) {
  return (
    <>
      <div className="mx-4 h-px bg-line-2" />
      <div className="flex w-full items-center gap-3 px-4 py-3 text-[15px]">
        <Icon name="swap-horizontal" size={20} color="var(--m-ink-3)" />
        <button
          data-testid="tx-detail-peer"
          onClick={onOpen}
          className="m-tap min-w-0 flex-1 border-none bg-transparent p-0 text-left text-[14px] font-medium text-accent-deep"
        >
          {t('tx.pairedCounterpart')}
        </button>
        <button
          aria-label={t('tx.unpair')}
          data-testid="tx-detail-unpair"
          onClick={onUnpair}
          className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-4"
        >
          <Icon name="link-off" size={16} />
        </button>
      </div>
    </>
  );
}

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
      <Sheet open={open} onOpenChange={setOpen} title={t('tx.bulkOffer', { n: selected.size })} height={760} dragHandle>
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
    // 'form' height: on iOS the sheet lifts by the keyboard height —
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

/** the container's type + counterparty rows — gone the moment a real
 *  split exists (#126 r4: the parts carry those). Module-level for
 *  S3776: the condition lives here, not in the screen. */
function ContainerTypeRows({
  hidden,
  kind,
  detailType,
  locked,
  onKind,
  counterIban,
  counterAccountName,
  linkedAccountName,
  onOpenAccount,
  onEditCounter,
}: Readonly<{
  hidden: boolean;
  kind: TxKind;
  detailType: TxType | null;
  locked: boolean;
  onKind: () => void;
  counterIban: string | undefined;
  counterAccountName: string | undefined;
  linkedAccountName: string | undefined;
  onOpenAccount: () => void;
  onEditCounter: () => void;
}>) {
  if (hidden) return null;
  return (
    <>
      <div className="mx-4 h-px bg-line-2" />
      <DetailKindRow kind={kind} detailType={detailType} locked={locked} onOpen={onKind} />
      <div className="mx-4 h-px bg-line-2" />
      <CounterpartyRow
        counterIban={counterIban}
        counterAccountName={counterAccountName}
        linkedAccountName={linkedAccountName}
        editable={kind === 'transfer'}
        onOpenAccount={onOpenAccount}
        onEdit={onEditCounter}
      />
    </>
  );
}

/** which split door the detail shows (#126 r4): the visible Split row
 *  on a whole transaction, Manage splits on a split one, nothing while
 *  the category is reimbursement-locked. Module-level for S3776. */
function splitDoorModeFor(multiPart: boolean, categoryLocked: boolean): 'row' | 'manage' | 'none' {
  if (multiPart) return 'manage';
  return categoryLocked ? 'none' : 'row';
}

/** the door itself, placed either inside the categories card (row) or
 *  under it (manage) — renders only its own placement */
function DetailSplitDoor({
  mode,
  placement,
  onOpen,
}: Readonly<{ mode: 'row' | 'manage' | 'none'; placement: 'row' | 'manage'; onOpen: () => void }>) {
  const { t } = useLang();
  if (mode !== placement) return null;
  if (mode === 'row') {
    return (
      <button
        data-testid="tx-detail-split-row"
        onClick={onOpen}
        className="m-tap flex w-full items-center gap-3 border-t border-line-2 bg-transparent px-4 py-3 text-left text-[14px] text-ink"
      >
        <Icon name="call-split" size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">{t('split.title')}</span>
        <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
      </button>
    );
  }
  return (
    <button
      data-testid="tx-detail-manage-splits"
      onClick={onOpen}
      className="m-tap mt-2 flex w-full items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-transparent px-4 py-2.5 text-[13px] font-medium text-accent-deep"
    >
      <Icon name="tune" size={15} />
      {t('review.manageSplits')}
    </button>
  );
}

// ── small derivations, module-level so the screen stays readable to
// Sonar (S3776) ──
const catBulkTargets = (
  allTxs: SpaceTx[] | undefined,
  tx: SpaceTx,
  offer: { catId: string } | null,
): SpaceTx[] => (offer ? similarTo(allTxs, tx, (item) => item.catId !== offer.catId) : []);
const titleBulkTargets = (
  allTxs: SpaceTx[] | undefined,
  tx: SpaceTx,
  bulk: { title: string } | null,
): SpaceTx[] => (bulk ? similarTo(allTxs, tx, (item) => (item.titleOverride ?? '') !== bulk.title) : []);
const normalizedCounterIban = (tx: SpaceTx | undefined): string | undefined =>
  tx?.counterIban ? normalizeIban(tx.counterIban) : undefined;
const givenOutFor = (tx: SpaceTx | undefined, allTxs: readonly SpaceTx[] | undefined): number =>
  tx && tx.amountCents > 0 ? givenCents(allTxs ?? [], tx.id) : 0;
const findPartView = (parts: readonly TxSplit[], partParam: string | undefined): TxSplit | undefined =>
  partParam ? parts.find((s) => s.id === partParam) : undefined;
const valuesEditorValue = (
  valuesMode: boolean,
  stage: TxSplit[] | null,
  multiPart: boolean,
  parts: TxSplit[],
): TxSplit[] | undefined => {
  if (!valuesMode) return undefined;
  return stage ?? (multiPart ? parts : undefined);
};

/** the app bar's pencil: rename on bank rows, full edit on manual ones,
 *  nothing on a part page (the container owns both). Module-level for
 *  S3776. */
function detailTrailingAction(
  isPart: boolean,
  importRef: string | undefined,
  t: TFunc,
  onRename: () => void,
  onEdit: () => void,
): ReactNode {
  if (isPart) return undefined;
  if (importRef) {
    return (
      <IconButton label={t('tx.renameTitle')} testId="tx-detail-rename" onClick={onRename}>
        <Icon name="pencil-outline" size={20} />
      </IconButton>
    );
  }
  return (
    <IconButton label={t('action.edit')} testId="tx-detail-edit" onClick={onEdit}>
      <Icon name="pencil-outline" size={20} />
    </IconButton>
  );
}

/** the app bar's name: the whole transaction's title, or the part's
 *  own face on a part page. Module-level for S3776. */
function detailScreenTitle(tx: SpaceTx, parts: readonly TxSplit[], partView: TxSplit | undefined, t: TFunc): string {
  if (!partView) return txTitle(tx);
  return partView.label ?? `${txTitle(tx)} – ${t('split.partN', { n: parts.indexOf(partView) + 1 })}`;
}

/** drafted-until-complete (#126 r4): the staged split may Apply only
 *  when every part has a real category and no two parts tell the same
 *  transfer/special story twice (r6: standard parts repeat freely).
 *  Module-level for S3776. */
const stagedSplitComplete = (stage: TxSplit[] | null, rowType: TxType): boolean =>
  !!stage && stage.every((s) => s.catId !== UNCATEGORIZED_ID) && !conflictingPartKinds(stage, rowType);

/** back to a whole transaction: one category, split gone — the settled
 *  Reimbursed slice keeps the gross partition when it exists.
 *  Module-level for S3776. */
function writeUnsplit(
  transform: ReturnType<typeof useTxTransform>,
  tx: SpaceTx,
  fallbackCatId: string,
  settledSlices: readonly TxSplit[],
  catId: string,
): void {
  const cat = catId !== UNCATEGORIZED_ID ? catId : fallbackCatId;
  if (settledSlices.length > 0) {
    const settled = settledSlices.reduce((sum, s) => sum + s.amountCents, 0);
    const rest = Math.max(0, Math.abs(tx.amountCents) - settled);
    void transform(tx, {
      splits: [...(rest > 0 ? [{ catId: cat, amountCents: rest }] : []), ...settledSlices],
      catId: cat,
    });
  } else {
    void transform(tx, { splits: null as never, catId: cat });
  }
}

/** the split flow's two sheets (#126 r4) — one editor, two doors: the
 *  classic per-slice categories, or values-only whose Done only STAGES;
 *  the completion deck's Apply is the ONE write. Module-level for
 *  S3776. */
function DetailSplitSheets({
  tx,
  splitOpen,
  setSplitOpen,
  valuesMode,
  editorValue,
  allowedCatIds,
  setCategory,
  unsplitTo,
  unsplitFallbackCat,
  splitStage,
  setSplitStage,
  completeOpen,
  setCompleteOpen,
  activeEvents,
  lockedKind,
  openValuesEditor,
  stageComplete,
  applyStagedSplit,
}: Readonly<{
  tx: SpaceTx;
  splitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
  valuesMode: boolean;
  editorValue: TxSplit[] | undefined;
  allowedCatIds?: readonly string[];
  setCategory: (catId: string) => void;
  unsplitTo: (catId: string) => void;
  unsplitFallbackCat: string;
  splitStage: TxSplit[] | null;
  setSplitStage: (stage: TxSplit[] | null) => void;
  completeOpen: boolean;
  setCompleteOpen: (open: boolean) => void;
  activeEvents: readonly { id: string; name: string; icon?: string }[];
  lockedKind: boolean;
  openValuesEditor: () => void;
  stageComplete: boolean;
  applyStagedSplit: () => void;
}>) {
  const { t } = useLang();
  return (
    <>
      <SplitEditorSheet
        open={splitOpen}
        onOpenChange={setSplitOpen}
        tx={tx}
        seedSingle
        allowedCatIds={allowedCatIds}
        valuesOnly={valuesMode}
        value={editorValue}
        txType={valuesMode ? tx.txType : undefined}
        onApplySingle={valuesMode ? unsplitTo : setCategory}
        onApply={
          valuesMode
            ? (splits) => {
                if (splits?.length) {
                  setSplitStage(splits);
                  setCompleteOpen(true);
                } else {
                  unsplitTo(unsplitFallbackCat);
                }
              }
            : undefined
        }
      />
      {/* drafted-until-complete (#126 r4): every part takes its category,
          type and event here; Apply is the ONE write */}
      <Sheet
        open={completeOpen}
        onOpenChange={(next) => {
          if (!next) setCompleteOpen(false);
        }}
        title={t('split.completeTitle')}
        size="tall"
      >
        <div className="flex flex-col gap-2 pt-1" data-testid="split-complete">
          <ReviewPartDeck
            splits={splitStage ?? undefined}
            rowType={tx.txType}
            tx={tx}
            activeEvents={activeEvents}
            allowedCatIds={allowedCatIds}
            lockedKind={lockedKind}
            onOpenValues={() => {
              setCompleteOpen(false);
              openValuesEditor();
            }}
            onSplits={(next) => setSplitStage([...next])}
          />
          <Button data-testid="split-apply" onClick={applyStagedSplit} disabled={!stageComplete}>
            {t('split.applyAll')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

/** the part page's sister list (#126 r4) — every part one tap away,
 *  the current one inert. Module-level for S3776. */
function PartSiblingRows({
  tx,
  parts,
  currentId,
  onOpen,
}: Readonly<{
  tx: SpaceTx;
  parts: readonly TxSplit[];
  currentId: string | undefined;
  onOpen: (partId: string | undefined) => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-part-siblings">
      {parts.map((slice, i) => {
        const sliceCat = cats.byId(slice.catId);
        const self = slice.id === currentId;
        return (
          <button
            key={slice.id ?? i}
            data-testid={`tx-part-sibling-${i}`}
            disabled={self}
            onClick={() => onOpen(slice.id)}
            className={`m-tap flex w-full items-center gap-2.5 border-b border-line-2 px-4 py-2.5 text-left last:border-0 ${self ? 'bg-bg-2' : ''}`}
          >
            <Icon name={sliceCat.icon} size={16} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">
              {slice.label ?? `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}`}
              <span className="text-[11px] font-normal text-ink-4"> · {catName(sliceCat, t)}</span>
            </span>
            <span className="m-num text-[12px] text-ink-2">{fmtCents(slice.amountCents, tx.currency, lang)}</span>
            {!self && <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />}
          </button>
        );
      })}
    </div>
  );
}

/** one part as its own transaction page (#126 r4): the sub-transaction
 *  the list drilled into — its share as the headline, its OWN type,
 *  category and event editable in place (write-through: the split is
 *  already complete), its siblings one tap away, and the manage door
 *  for the amounts. Container-only facts (notes, reimbursements,
 *  receipts, delete) stay on the whole transaction. */
function PartDetailBody({
  tx,
  part,
  parts,
  accountName,
  ownStamp,
  activeEvents,
  allowedCatIds,
  onManageSplits,
}: Readonly<{
  tx: SpaceTx;
  part: TxSplit;
  parts: readonly TxSplit[];
  accountName: string | undefined;
  ownStamp: boolean;
  activeEvents: readonly { id: string; name: string; icon?: string }[];
  allowedCatIds?: readonly string[];
  onManageSplits: () => void;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const transform = useTxTransform();
  const navigate = useNavigate();
  const accounts = useSpaceAccounts();
  const [kindOpen, setKindOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  // r6: the part's money spreading across several categories
  const [spreadOpen, setSpreadOpen] = useState(false);
  const [typeClash, setTypeClash] = useState(false);

  const sign = tx.amountCents < 0 ? -1 : 1;
  const partCat = cats.byId(part.catId);
  const partColor = partCat.color ?? cats.byId(partCat.parentId ?? '').color;
  // transfer-PRESENTING only with a real counterparty: a ◆ special part
  // (Set aside without a pot) is transfer-family by type yet reads as
  // its own standard story ("Saving"), not as a bare Transfer
  const transferPart = !!part.linkedAccountId && !!part.txType && kindOf(part.txType) === 'transfer';
  // flat consts so the JSX carries no branching (S3776)
  const partKind: 'transfer' | 'standard' = transferPart ? 'transfer' : 'standard';
  const counterName = accounts?.find((a) => a.id === part.linkedAccountId)?.name ?? t('tx.counterNone');
  const kindSub = transferPart ? counterName : t(`tx.type.${part.txType ?? tx.txType}`);
  const kindRowIcon = ownStamp ? 'lock-outline' : 'pencil-outline';
  const partDirection: 'debit' | 'credit' = tx.amountCents < 0 ? 'debit' : 'credit';
  const partEvent = activeEvents.find((e) => e.id === part.eventId);
  const spread = part.cats?.length ? part.cats.map((c) => catName(cats.byId(c.catId), t)).join(' · ') : undefined;
  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });
  // r5: the links that target THIS part, and what the part is net worth
  const allTxs = useSpaceTransactions();
  const partLinks = (tx.reimbursements ?? []).filter((r) => r.partId === part.id);
  const partLinkedCents = partLinks.reduce((sum, r) => sum + r.amountCents, 0);
  const creditTitleOf = (id: string) => {
    const credit = allTxs?.find((row) => row.id === id);
    return credit ? txTitle(credit) : id;
  };

  /** per-part write-through — refused when it would leave two parts
   *  telling the same transfer/special story twice (#126 r4/r6) */
  const patchPart = (patch: Partial<TxSplit>): void => {
    const nextSplits = (tx.splits ?? []).map((s) => (s.id === part.id ? { ...s, ...patch } : s));
    const nonReimb = nextSplits.filter((s) => s.catId !== REIMBURSED_ID);
    if (conflictingPartKinds(nonReimb, tx.txType)) {
      setTypeClash(true);
      return;
    }
    setTypeClash(false);
    void transform(tx, { splits: nextSplits, catId: primaryCatId(nonReimb) ?? tx.catId }, 'txCategory');
  };

  return (
    <>
      <div className="flex flex-col items-center py-6 text-center">
        <div className="m-num text-4xl text-ink" data-testid="tx-part-amount">
          {fmtCents(sign * Math.abs(part.amountCents), tx.currency, lang, { sign: true })}
        </div>
        <div className="mt-1 text-sm text-ink-3">
          {fmtDay.format(new Date(tx.date))}
          {tx.time ? ` · ${tx.time}` : ''}
        </div>
        {/* whose money this is a piece of */}
        <div className="mt-1 text-[12px] text-ink-4">{txTitle(tx)}</div>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex items-center gap-3 px-4 py-3.5 text-[15px] text-ink" data-testid="tx-part-account-row">
          <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1 truncate">{accountName ?? '—'}</span>
          <span className="text-xs text-ink-4">{t('txform.account')}</span>
        </div>
        <div className="mx-4 h-px bg-line-2" />
        <button
          data-testid="tx-part-kind-row"
          onClick={ownStamp ? undefined : () => setKindOpen(true)}
          className="m-tap flex w-full items-center gap-2.5 border-none bg-transparent px-4 py-2.5 text-left text-[14px] text-ink"
        >
          <Icon name={TX_KIND_VISUAL[partKind].icon} size={18} color={TX_KIND_VISUAL[partKind].color} />
          <span className="min-w-0 flex-1 truncate">
            {t(`tx.kind.${partKind}`)}
            <span className="text-[12px] font-normal text-ink-4"> · {kindSub}</span>
          </span>
          <span className="text-[11px] text-ink-4">{t('tx.kindTitle')}</span>
          <Icon name={kindRowIcon} size={13} color="var(--m-ink-4)" />
        </button>
        {typeClash && (
          <p className="mx-4 mb-3 rounded-card bg-negative-soft px-3 py-2 text-[12px] leading-relaxed text-negative" data-testid="tx-part-type-clash">
            {t('split.typeDuplicate')}
          </p>
        )}
      </div>

      <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
        <button
          data-testid="tx-part-category"
          onClick={spread ? () => setSpreadOpen(true) : () => setPickerOpen(true)}
          className="m-tap flex w-full items-center gap-3 bg-transparent px-4 py-3.5 text-left"
        >
          <Icon name={partCat.icon} size={20} color={partColor ?? 'var(--m-ink-3)'} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] text-ink">{spread ?? catName(partCat, t)}</span>
            {!spread && partCat.parentId && (
              <span className="block truncate text-[11px] text-ink-4">{catName(cats.byId(partCat.parentId), t)}</span>
            )}
          </span>
          <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
        </button>
        {/* r6 (user request): a part is a full transaction — its money
            may spread across SEVERAL categories of its own */}
        {!transferPart && !spread && (
          <button
            data-testid="tx-part-spread"
            onClick={() => setSpreadOpen(true)}
            className="m-tap flex w-full items-center gap-2 bg-transparent px-4 pb-3 text-left text-[12px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={13} />
            {t('split.spreadDoor')}
          </button>
        )}
      </div>

      <button
        data-testid="tx-part-event"
        onClick={() => setEventOpen(true)}
        className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left text-[14px] text-ink"
      >
        <Icon name="party-popper" size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">{partEvent?.name ?? t('events.linkNone')}</span>
        <span className="text-[11px] text-ink-4">{t('events.linkTitle')}</span>
        <Icon name="pencil-outline" size={13} color="var(--m-ink-4)" />
      </button>

      {/* r5: the part's own note — parts are full transactions */}
      <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface">
        <textarea
          data-testid="tx-part-notes"
          defaultValue={part.notes ?? ''}
          placeholder={t('tx.notesPlaceholder')}
          rows={2}
          onBlur={(e) => {
            const next = e.target.value.trim() || undefined;
            if (next !== part.notes) patchPart({ notes: next });
          }}
          className="w-full resize-none bg-transparent px-4 py-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>

      {/* r5: the part's own reimbursements — links born here target THIS
          part; the whole pair still shows on the container */}
      <div className="m-cap mt-5 mb-1 flex items-baseline justify-between px-1">
        <span>{t('reimb.section')}</span>
        <button
          data-testid="tx-part-reimb-link"
          onClick={() =>
            void navigate({ to: '/transactions/$txId/link-reimb', params: { txId: tx.id }, search: { part: part.id } })
          }
          className="m-tap border-none bg-transparent text-[11px] font-semibold text-accent-deep"
        >
          {t('reimb.link')}
        </button>
      </div>
      <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-part-reimbs">
        {partLinks.map((linkRow) => (
          <div key={`${linkRow.txId}-${linkRow.partId}`} className="flex items-center gap-3 border-b border-line-2 px-4 py-2.5 text-[13px] last:border-0">
            <Icon name="cash-refund" size={16} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate text-ink">{creditTitleOf(linkRow.txId)}</span>
            <span className="m-num text-ink-2">{fmtCents(linkRow.amountCents, tx.currency, lang)}</span>
          </div>
        ))}
        <div className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
          <span className="min-w-0 flex-1 text-ink-3">{t('reimb.net')}</span>
          <span className="m-num font-semibold text-ink" data-testid="tx-part-net">
            {fmtCents(sign * Math.max(0, Math.abs(part.amountCents) - partLinkedCents), tx.currency, lang, { sign: true })}
          </span>
        </div>
      </div>

      {/* the sisters: every part one tap away (#126 r4) */}
      <div className="m-cap mt-5 mb-1 px-1">{t('split.title')}</div>
      <PartSiblingRows
        tx={tx}
        parts={parts}
        currentId={part.id}
        onOpen={(partId) =>
          void navigate({ to: '/transactions/$txId', params: { txId: tx.id }, search: { part: partId } })
        }
      />
      <button
        data-testid="tx-part-manage"
        onClick={onManageSplits}
        className="m-tap mt-2 flex w-full items-center justify-center gap-1.5 rounded-card border border-dashed border-line bg-transparent px-4 py-2.5 text-[13px] font-medium text-accent-deep"
      >
        <Icon name="tune" size={15} />
        {t('review.manageSplits')}
      </button>
      <button
        data-testid="tx-part-whole"
        onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: tx.id }, search: {} })}
        className="m-tap mt-2 flex w-full items-center justify-center gap-1.5 rounded-card border border-line bg-surface px-4 py-2.5 text-[13px] font-medium text-ink"
      >
        <Icon name="receipt-text-outline" size={15} />
        {t('tx.partWhole')}
      </button>

      <TxKindSheet
        open={kindOpen}
        onOpenChange={setKindOpen}
        current={partKind}
        allowAdjustment={false}
        onPick={(nextKind) => {
          if (nextKind === 'transfer') setCounterOpen(true);
          else patchPart({ txType: undefined, linkedAccountId: undefined, transferPeerId: undefined });
          setKindOpen(false);
        }}
      />
      <CounterpartySheet
        open={counterOpen}
        onOpenChange={setCounterOpen}
        excludeAccountId={tx.accountId}
        currentLinkedId={part.linkedAccountId}
        onChoose={(picked) =>
          patchPart({ txType: 'transfer', linkedAccountId: picked.id, catId: autoSubFor('transfer', tx.amountCents) ?? part.catId })
        }
      />
      <CategoryPicker
        open={pickerOpen}
        onOpenChange={(next) => {
          if (!next) setPickerOpen(false);
        }}
        direction={partDirection}
        txType={tx.txType}
        selectedId={part.catId}
        onlyIds={allowedCatIds}
        onPick={(catId) => {
          const pulled = specialCatType(catId);
          const clearPulled = part.txType && !part.linkedAccountId ? { txType: undefined } : {};
          // a deliberate single pick flattens any category spread — the
          // stale cats array would otherwise keep telling the old story
          patchPart({ catId, cats: undefined, ...(pulled ? { txType: pulled } : clearPulled) });
        }}
      />
      {/* r6: several categories inside THIS part, scoped to its amount */}
      <PartCatsSheet
        open={spreadOpen}
        onOpenChange={setSpreadOpen}
        part={part}
        currency={tx.currency}
        direction={partDirection}
        txType={tx.txType}
        allowedCatIds={allowedCatIds}
        onApply={(entries) => {
          patchPart(catsPatch(entries));
          setSpreadOpen(false);
        }}
      />
      <Sheet
        open={eventOpen}
        onOpenChange={setEventOpen}
        title={t('events.linkTitle')}
        size="form"
        dragHandle
      >
        <div className="pt-1" data-testid="tx-part-event-list">
          <button
            data-testid="tx-part-event-none"
            onClick={() => {
              patchPart({ eventId: undefined });
              setEventOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('events.linkNone')}</span>
          </button>
          {activeEvents.map((event) => (
            <button
              key={event.id}
              data-testid={`tx-part-event-${event.id}`}
              onClick={() => {
                patchPart({ eventId: event.id });
                setEventOpen(false);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
            >
              <Icon name={event.icon ?? 'party-popper'} size={18} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1 truncate">{event.name}</span>
              {part.eventId === event.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
          ))}
        </div>
      </Sheet>
    </>
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
  const [loanCountBusy, setLoanCountBusy] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  // #126 r4: the values door + drafted-until-complete stage — splitting
  // from the detail writes NOTHING until every part is complete, then
  // lands in ONE write (no half-deployed splits, easy bulk updates)
  const [splitValuesMode, setSplitValuesMode] = useState(false);
  const [splitStage, setSplitStage] = useState<TxSplit[] | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const { part: partParam } = useSearch({ strict: false }) as { part?: string };
  const [recurringOpen, setRecurringOpen] = useState(false);
  // create-and-return doors (user request): snapshot of pre-existing ids
  // so the freshly created row is identifiable and auto-links to this tx
  const [recCreating, setRecCreating] = useState(false);
  const [eventCreating, setEventCreating] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [bulkOffer, setBulkOffer] = useState<{ catId: string; txType: TxType; count: number } | null>(null);
  // the reimbursement total at arm time: a settlement AFTER arming
  // rewrites the category attribution, so the stale offer must retire
  // (user rule: any category change — direct or indirect — re-evaluates)
  const bulkArmedReimbRef = useRef(0);
  // which of the similar transactions the bulk apply will touch (user
  // request: see and pick them, not a blind apply-all)
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loanPickOpen, setLoanPickOpen] = useState(false);
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
  // a transfer into a loan account IS a payment on that loan (v2: the
  // account is the debt) — say so, matching the review card's debt row
  // read-time join (user request): the moment an account with this IBAN
  // exists locally — e.g. it was attached to a space later — every
  // transaction's counterparty upgrades from plain text to a live door
  const counterIban = normalizedCounterIban(tx);
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
  const givenOut = givenOutFor(tx, allTxs);

  // a settlement AFTER the bulk offer armed rewrote the attribution —
  // the offer's premise is stale, retire it (user rule)
  const reimbNow = tx ? totalReimbursedCents(tx) + givenOut : 0;
  useEffect(() => {
    if (bulkOffer && reimbNow !== bulkArmedReimbRef.current) setBulkOffer(null);
  }, [reimbNow, bulkOffer]);

  // display-currency lens: the headline converts at THIS day's fixing
  const { fmt, ensureDates } = useDisplayMoney();
  const txDate = tx?.date;
  useEffect(() => {
    if (txDate) ensureDates([txDate]);
  }, [txDate, ensureDates]);

  if (!tx)
    return <div className="h-full" data-testid="screen-tx-detail" />;

  const netCents = tx.amountCents > 0 ? netCreditCents(tx, givenOut) : netAmountCents(tx);
  const headlineAmount = fmt(netCents, tx.currency, { sign: true, date: tx.date });

  const cat = cats.byId(tx.catId);
  const parent = cat.parentId ? cats.byId(cat.parentId) : undefined;
  const color = cat.color ?? parent?.color ?? 'var(--m-ink-3)';
  const kind = kindOf(tx.txType);
  // R1: the row's own account stamps its type — the kind row locks
  const ownStamp = accountStamp(account?.type);
  const kindDetailType = kindDetail(tx.txType);
  const pairState = transferPairState(tx, linkedAccount);
  // the OTHER leg's side of a release — its own row clears in the same
  // write. The peer is fetched from the STORE when the live snapshot
  // hasn't emitted it yet (a slow liveQuery beat left the peer's
  // transferPeerId dangling — CI-only flake)
  const releasePeer = async () => {
    const peerId = tx.transferPeerId;
    if (!peerId) return;
    const peer =
      (allTxs ?? []).find((item) => item.id === peerId) ??
      (await visibleTransactions(store, spaceId)).find((item) => item.id === peerId);
    if (peer) await writeTxTransform(repo, peer, { transferPeerId: null as never });
  };
  // unpairing releases BOTH legs — one activity entry covers the action
  const unpair = () => {
    void releasePeer();
    void transform(tx, { transferPeerId: null as never }, 'txLink');
  };
  // counter pick, bare label and kind pick all write through the same
  // coherence rules (arc 2: the locked family sub files by sign); a
  // peered leg whose link moves away releases its old mirror first —
  // a stale transferPeerId would keep collapsing the pair in the list
  const retype = (nextType: TxType, nextLinkedId: string | null, action: 'txLink' | 'txCategory') => {
    const fields = applyTypeChange({
      nextType,
      linkedAccountId: nextLinkedId,
      currentCatId: tx.catId,
      catTxTypes: cats.byId(tx.catId).txTypes,
      amountCents: tx.amountCents,
    });
    const unpeer = !!tx.transferPeerId && tx.linkedAccountId !== nextLinkedId;
    if (unpeer) void releasePeer();
    void transform(
      tx,
      { ...fields, linkedAccountId: nextLinkedId as never, ...(unpeer ? { transferPeerId: null as never } : {}) },
      action,
    );
  };
  // a credit that self-filed as Reimbursed keeps that category as long
  // as any link lives (user rule) — unlink first, then recategorize
  const categoryLocked = tx.catId === REIMBURSED_ID && givenOut > 0;
  // the recurring OWNS the category (user rule 2026-07-28): a linked row
  // only picks between the recurring's category and expected
  // reimbursement — the editor's picker enforces it
  const recurringAllowedCats = recurringCatConstraint(tx, recurrings);

  // #126 r4: the split's parts (the settled Reimbursed slice is
  // bookkeeping, not a part) — with a real split the container steps
  // back and the parts carry the stories
  const parts = (tx.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID);
  const settledSlices = (tx.splits ?? []).filter((s) => s.catId === REIMBURSED_ID);
  const multiPart = parts.length > 1;
  const activeEventsList = (events ?? []).filter((e) => e.archived !== 1);
  // the completion stage: values Done stages; Apply writes once whole
  const stageComplete = stagedSplitComplete(splitStage, tx.txType);
  const unsplitFallbackCat = primaryCatId(parts) ?? tx.catId ?? UNCATEGORIZED_ID;
  const openValuesEditor = () => {
    setSplitValuesMode(true);
    setSplitOpen(true);
  };
  const openClassicEditor = () => {
    setSplitValuesMode(false);
    setSplitOpen(true);
  };
  // the categories pencil: a split container routes into the manage
  // flow; a whole one keeps the classic per-slice editor
  const openCategoriesEditor = multiPart ? openValuesEditor : openClassicEditor;
  const splitDoorMode = splitDoorModeFor(multiPart, categoryLocked);
  const applyStagedSplit = () => {
    if (!splitStage || !stageComplete) return;
    // the stage lands in ONE write — settled value rides along untouched
    void transform(tx, {
      splits: [...splitStage, ...settledSlices],
      catId: primaryCatId(splitStage) ?? tx.catId,
    });
    setSplitStage(null);
    setCompleteOpen(false);
  };
  const unsplitTo = (catId: string) => {
    setSplitStage(null);
    writeUnsplit(transform, tx, unsplitFallbackCat, settledSlices, catId);
  };

  const setCategory = (catId: string) => {
    // R3: a marked special category carries the bare story — the type
    // follows the pick (Set aside → saving); ordinary cats keep the old
    // first-declared-type rule
    const txType = specialCatType(catId) ?? cats.byId(catId).txTypes[0] ?? tx.txType;
    void transform(tx, { catId, txType, needsReview: 0 }, 'txCategory');
    // the flat structure's loan question (Q1): a debt-family pick asks —
    // optionally — WHICH loan; skipping keeps the default-loan bucket
    if (specialCatType(catId) === 'debtPayment' && !tx.linkedAccountId && !ownStamp) setLoanPickOpen(true);
    // bulk mechanism from the detail too (user request) — unlike review
    // it reaches EVERYTHING of this merchant, reviewed included. The
    // settlement category is never a bulk suggestion (user rule).
    const similar = catId === REIMBURSED_ID ? [] : similarTo(allTxs, tx, (item) => item.catId !== catId);
    bulkArmedReimbRef.current = reimbNow;
    setBulkOffer(similar.length > 0 ? { catId, txType, count: similar.length } : null);
    setBulkSelected(new Set(similar.map((item) => item.id)));
  };

  const bulkTargets = catBulkTargets(allTxs, tx, bulkOffer);

  /** rename: '' clears the override (LWW needs the explicit value) */
  const renameTitle = (raw: string) => {
    const title = raw.trim();
    const next = title && title !== cleanBankText(tx.merchant) ? title : '';
    void transform(tx, { titleOverride: next });
    const similar = similarTo(allTxs, tx, (item) => (item.titleOverride ?? '') !== next);
    setTitleBulk(next && similar.length > 0 ? { title: next } : null);
    setTitleSelected(new Set(similar.map((item) => item.id)));
  };

  const titleTargets = titleBulkTargets(allTxs, tx, titleBulk);

  const applyTitleBulk = async () => {
    if (!titleBulk) return;
    const picked = titleTargets.filter((target) => titleSelected.has(target.id));
    // one history line for the whole bulk, not one per sibling
    for (const item of picked) await transform(item, { titleOverride: titleBulk.title }, null);
    if (picked.length) void logActivity(store, repo, spaceId, 'txEdit', `${txTitle(tx)} +${picked.length}`);
    setTitleBulk(null);
  };

  const applyBulk = async () => {
    if (!bulkOffer) return;
    const picked = bulkTargets.filter((target) => bulkSelected.has(target.id));
    // one history line for the whole bulk, not one per sibling
    for (const item of picked) await transform(item, { catId: bulkOffer.catId, txType: bulkOffer.txType, needsReview: 0 }, null);
    if (picked.length) void logActivity(store, repo, spaceId, 'txCategory', `${txTitle(tx)} +${picked.length}`);
    setBulkOffer(null);
  };
  const saveNotes = (notes: string) => {
    if (notes === (tx.notes ?? '')) return;
    void transform(tx, { notes }, null); // 'note' is the richer line
    void logActivity(store, repo, spaceId, 'note', txTitle(tx));
  };

  // two-tap confirm, matching the app's other destructive rows
  const deleteManualTx = async () => {
    await deleteManualTxRow(store, repo, spaceId, tx, account);
    void navigate({ to: '/transactions' });
  };

  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });

  // #126 r4: ?part=<id> shows ONE part as its own transaction page
  const partView = findPartView(parts, partParam);
  const screenTitle = detailScreenTitle(tx, parts, partView, t);
  const trailingAction = detailTrailingAction(!!partView, tx.importRef, t, () => setRenameOpen(true), () => setEditOpen(true));
  // the values editor edits the STAGE when one exists, else the stored
  // parts; classic mode stays uncontrolled
  const editorValue = valuesEditorValue(splitValuesMode, splitStage, multiPart, parts);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-tx-detail">
      <AppBar
        title={screenTitle}
        leading={
          <DetailBackButton panes={panes} onClose={() => void navigate({ to: '/transactions', replace: true })} t={t} />
        }
        trailing={trailingAction}
      />
      {!tx.importRef && <TxFormSheet open={editOpen} onOpenChange={setEditOpen} tx={tx} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {partView ? (
          <PartDetailBody
            key={partView.id}
            tx={tx}
            part={partView}
            parts={parts}
            accountName={account?.name}
            ownStamp={!!ownStamp}
            activeEvents={activeEventsList}
            allowedCatIds={recurringAllowedCats}
            onManageSplits={openValuesEditor}
          />
        ) : (
          <>
        <div className="flex flex-col items-center py-6 text-center">
          {/* both directions show the net truth: expenses minus what came
              back, credits minus what they refunded elsewhere */}
          <div className="m-num text-4xl text-ink" data-testid="tx-detail-amount">
            {headlineAmount}
          </div>
          <div className="mt-1 text-sm text-ink-3">
            {fmtDay.format(new Date(tx.date))}
            {tx.time ? ` · ${tx.time}` : ''}
          </div>
          {/* converted headline (display-currency lens): the recorded truth
              stays one line below — a detail screen must never hide it */}
          {headlineAmount.startsWith('≈') && (
            <div className="m-num mt-0.5 text-[13px] text-ink-4" data-testid="tx-detail-recorded-amount">
              {fmtCents(netCents, tx.currency, lang, { sign: true })}
            </div>
          )}
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
              {linkedAccount && ['loan', 'mortgage'].includes(linkedAccount.type) && (
                <span className="block truncate text-[11px] text-accent-deep" data-testid="tx-detail-pays-debt">
                  {t('tx.paysDebt', { name: linkedAccount.name })}
                </span>
              )}
              {/* pre-anchor payment (loans v2): dated before the loan's
                  known-true balance, so it did NOT move the balance —
                  the user can deliberately count it in, once */}
              {tx && linkedAccount && offersLoanCount(tx, linkedAccount) && (
                  <button
                    data-testid="tx-detail-loan-count"
                    disabled={loanCountBusy}
                    onClick={() => {
                      // one-shot with a busy latch: the liveQuery re-emit
                      // that hides this button trails the write (review
                      // finding: a double-tap applied the delta twice)
                      setLoanCountBusy(true);
                      void countPreAnchorTx(store, repo, { ...tx, linkedAccountId: linkedAccount.id } as never, () =>
                        writeTxTransform(repo, tx, { loanCounted: 1 }),
                      ).finally(() => setLoanCountBusy(false));
                    }}
                    className="m-tap mt-0.5 block border-none bg-transparent p-0 text-left text-[11px] text-warning underline disabled:opacity-50"
                  >
                    {t('tx.loanNotCounted')}
                  </button>
                )}
            </span>
            <span className="text-xs text-ink-4">{t('txform.account')}</span>
          </div>
          <ContainerTypeRows
            hidden={multiPart}
            kind={kind}
            detailType={kindDetailType}
            locked={!!ownStamp}
            onKind={() => setTypePickOpen(true)}
            counterIban={tx.counterIban}
            counterAccountName={counterAccount?.name}
            linkedAccountName={linkedAccount?.name}
            onOpenAccount={() => setCounterOpen(true)}
            onEditCounter={() => setCounterPickOpen(true)}
          />
          {pairState === 'peered' && (
            <TransferPeerRow
              t={t}
              onOpen={() => {
                const peerId = tx.transferPeerId;
                if (peerId) void navigate({ to: '/transactions/$txId', params: { txId: peerId } });
              }}
              onUnpair={() => unpair()}
            />
          )}
          {pairState === 'awaiting' && (
            <div className="px-4 pb-3">
              <Pill testId="tx-detail-awaiting">{t('tx.awaitingCounterpart')}</Pill>
            </div>
          )}
          {pairState === 'offerCreate' && (
            <button
              data-testid="tx-detail-create-counter"
              onClick={() => void healMissingMirror(store, repo, tx).catch(() => undefined)}
              className="m-tap w-full border-none bg-transparent px-4 pb-3 text-left text-[13px] font-medium text-accent-deep"
            >
              {t('tx.createCounterpart', { name: linkedAccount?.name ?? '' })}
            </button>
          )}
        </div>

        {/* block: categories — ONE edit affordance for the whole block
            (user: a pencil per slice read wrong); rows stay tappable */}
        <CategoriesHeader locked={categoryLocked} byRecurring={!!recurringAllowedCats} onEdit={openCategoriesEditor} />
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-detail-categories">
          <CategorySlices
            tx={tx}
            cats={cats}
            fallbackCat={cat}
            fallbackColor={color}
            onEdit={() => !categoryLocked && openCategoriesEditor()}
          />
          {/* the split door, in the open on the detail too (#126 r4) */}
          <DetailSplitDoor mode={splitDoorMode} placement="row" onOpen={openValuesEditor} />
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
        <DetailSplitDoor mode={splitDoorMode} placement="manage" onOpen={openValuesEditor} />

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
          onClick={() => void navigate({ to: '/tx-customize' })}
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
            onClick={() => setConfirmDelete(true)}
            className="m-tap mt-6 w-full rounded-card border border-line bg-surface px-4 py-3 text-center text-[14px] font-medium text-negative"
          >
            {t('tx.deleteManual')}
          </button>
        )}
          </>
        )}
      </div>

      {/* the aligned danger confirm — no cooldown: one transaction is a
          low-stakes delete (user ruling) */}
      <DangerConfirmSheet
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('tx.deleteManual')}
        body={t('tx.deleteManualBody', { name: txTitle(tx) })}
        cooldown={0}
        onConfirm={() => void deleteManualTx()}
        testId="tx-delete"
      />

      {/* the flat structure's loan question (Q1): picking one converts
          to the transfer approach — the choke point mints the loan's leg */}
      <LoanPickSheet
        open={loanPickOpen}
        onOpenChange={setLoanPickOpen}
        onPick={(accountId) =>
          void transform(tx, { linkedAccountId: accountId, txType: 'transfer', catId: autoSubFor('transfer', tx.amountCents) }, 'txLink')
        }
        onSkip={() => undefined}
      />

      {/* write-through: choosing a counterparty derives the transfer's
          exact member; the kind sheet handles standard/adjustment */}
      <CounterpartySheet
        open={counterPickOpen}
        onOpenChange={setCounterPickOpen}
        excludeAccountId={tx.accountId}
        currentLinkedId={tx.linkedAccountId}
        onChoose={(picked) => retype(typeForLinkedAccount(picked.type), picked.id, 'txLink')}
      />
      <TxKindSheet
        open={typePickOpen}
        onOpenChange={setTypePickOpen}
        current={kind}
        allowAdjustment={!tx.importRef && !tx.feedSpaceId}
        onPick={(nextKind) => {
          // transfer completes in the counterparty picker — nothing is
          // written until the other side is chosen (an account, or the
          // bare "no counter account" label)
          if (nextKind === 'transfer') {
            setCounterPickOpen(true);
            return;
          }
          retype(nextKind === 'adjustment' ? 'adjustment' : standardTypeFor(tx.amountCents), null, 'txCategory');
        }}
      />
      {/* ONE category flow (review parity): a single row edits the plain
          category through setCategory (which arms the bulk offer);
          added rows store a split write-through */}
      {/* one editor, two doors (#126 r4): the categories pencil keeps the
          classic per-slice editor (write-through), every split door opens
          the VALUES editor whose Done only STAGES — nothing is written
          until the completion deck's Apply lands the whole split */}
      <DetailSplitSheets
        tx={tx}
        splitOpen={splitOpen}
        setSplitOpen={setSplitOpen}
        valuesMode={splitValuesMode}
        editorValue={editorValue}
        allowedCatIds={recurringAllowedCats}
        setCategory={setCategory}
        unsplitTo={unsplitTo}
        unsplitFallbackCat={unsplitFallbackCat}
        splitStage={splitStage}
        setSplitStage={setSplitStage}
        completeOpen={completeOpen}
        setCompleteOpen={setCompleteOpen}
        activeEvents={activeEventsList}
        lockedKind={!!ownStamp}
        openValuesEditor={openValuesEditor}
        stageComplete={stageComplete}
        applyStagedSplit={applyStagedSplit}
      />
      <RenameTitleSheet
        open={renameOpen}
        onOpenChange={setRenameOpen}
        original={cleanBankText(tx.merchant)}
        value={txTitle(tx)}
        onSave={renameTitle}
      />

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
      <Sheet open={eventOpen} onOpenChange={setEventOpen} title={t('events.linkTitle')} size="form" dragHandle>
        <div className="pt-1" data-testid="tx-event-list">
          <button
            data-testid="tx-event-none"
            onClick={() => {
              void transform(tx, { eventId: '' }, 'txLink');
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
                  void transform(tx, { eventId: e.id }, 'txLink');
                  setEventOpen(false);
                }}
                className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink last:border-0"
              >
                <Icon name={e.icon ?? 'party-popper'} size={18} color="var(--m-accent-deep)" />
                <span className="min-w-0 flex-1 truncate">{e.name}</span>
                {tx.eventId === e.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
              </button>
            ))}
          <button
            data-testid="tx-event-create"
            onClick={() => {
              setEventCreating(true);
              setEventOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-t border-line-2 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={18} />
            {t('events.new')}
          </button>
        </div>
      </Sheet>
      {/* create-and-return: the fresh event auto-links to this tx */}
      {eventCreating && (
        <EventFormSheet
          initial="new"
          onSaved={(id) => void transform(tx, { eventId: id }, 'txLink')}
          onClose={() => setEventCreating(false)}
        />
      )}

      {/* attach to a recurring cost */}
      <Sheet open={recurringOpen} onOpenChange={setRecurringOpen} title={t('recurring.linkTitle')} size="form" dragHandle>
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
          <button
            data-testid="tx-recurring-create"
            onClick={() => {
              setRecCreating(true);
              setRecurringOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-t border-line-2 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={18} />
            {t('recurring.add')}
          </button>
        </div>
      </Sheet>
      {/* create-and-return: prefilled from THIS transaction, auto-links */}
      {recCreating && (
        <RecurringFormSheet
          initial={formFromTx(tx)}
          onSaved={(id) => void recurringOps.linkTx(tx, id)}
          onClose={() => setRecCreating(false)}
        />
      )}
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
/** a recurring-linked row's category allowlist: the recurring's own
 *  category plus expected reimbursement (S3776: extracted) */
function recurringCatConstraint(
  tx: { recurringId?: string },
  recurrings: { id: string; catId?: string }[] | undefined,
): string[] | undefined {
  const rec = tx.recurringId ? recurrings?.find((r) => r.id === tx.recurringId) : undefined;
  return rec?.catId ? [rec.catId, EXPECTED_REIMBURSE_ID] : undefined;
}

/** the categories caption: one Edit for the block — or a lock while a
 *  reimbursement owns the attribution (user rule; S3776: extracted) */
function CategoriesHeader({ locked, byRecurring, onEdit }: Readonly<{ locked: boolean; byRecurring?: boolean; onEdit: () => void }>) {
  const { t } = useLang();
  return (
    <div className="m-cap mt-5 mb-1 flex items-center justify-between px-1">
      <span>
        {t('screen.categories')}
        {/* informational, not a hard lock: Edit still opens the editor,
            whose picker only offers the recurring's category and
            expected reimbursement (user rule 2026-07-28) */}
        {byRecurring && !locked && (
          <span className="pl-2 font-normal text-ink-4" data-testid="tx-detail-cats-recurring">
            {t('tx.setByRecurring')}
          </span>
        )}
      </span>
      {locked ? (
        <span className="flex items-center gap-1 text-[11px] text-ink-4" data-testid="tx-detail-cats-locked">
          <Icon name="lock-outline" size={12} />
          {t('reimb.categoryLocked')}
        </span>
      ) : (
        <button
          data-testid="tx-detail-cats-edit"
          aria-label={t('action.edit')}
          onClick={onEdit}
          className="m-tap flex items-center gap-1 border-none bg-transparent text-[11px] font-semibold text-accent-deep"
        >
          <Icon name="pencil-outline" size={13} />
          {t('action.edit')}
        </button>
      )}
    </div>
  );
}

function CounterpartyRow({
  counterIban,
  counterAccountName,
  linkedAccountName,
  editable,
  onOpenAccount,
  onEdit,
}: Readonly<{
  counterIban?: string;
  counterAccountName?: string;
  linkedAccountName?: string;
  /** transfers only (user simplification): other kinds show the bank's
   *  counterparty as a plain fact, dimmed and untappable */
  editable: boolean;
  onOpenAccount: () => void;
  onEdit: () => void;
}>) {
  const { t } = useLang();
  const matched = !!counterAccountName;
  const primary = counterAccountName ?? linkedAccountName;
  const disabled = !matched && !editable;
  return (
    <button
      data-testid={matched ? 'tx-detail-counterparty-row' : 'tx-detail-counterparty-edit'}
      disabled={disabled}
      onClick={matched ? onOpenAccount : onEdit}
      className={`m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink ${disabled ? 'opacity-45' : ''}`}
    >
      <Icon name="swap-horizontal" size={20} color={primary ? 'var(--m-accent-deep)' : 'var(--m-ink-3)'} />
      <span className="min-w-0 flex-1">
        {primary ? (
          <span className="block truncate">{primary}</span>
        ) : (
          <span className="block truncate text-ink-3" data-testid="tx-detail-counter-add">
            {/* counterless transfers are legal (arc 2's bare exit): state
                the fact calmly — the tap still doors into the picker */}
            {counterIban ?? (editable ? t('tx.counterNone') : t('tx.counterNotApplicable'))}
          </span>
        )}
        {counterIban && primary && (
          <span className="block truncate font-mono text-[11px] text-ink-4">{counterIban}</span>
        )}
      </span>
      <span className="text-xs text-ink-4">{t('tx.counterparty')}</span>
      {!disabled && <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />}
    </button>
  );
}
