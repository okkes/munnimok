import { SelectAllRow } from '@/ui/SelectAllRow';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useQuery } from '@/db/useQuery';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { useLgViewport } from '@/lib/viewport';
import { useSpaceAccount, useSpaceAccounts, useSpaceTransaction, useSpaceTransactions, useTxTransform } from '@/application/transactions';
import { useDisplayMoney } from '@/features/currency/useDisplayMoney';
import { RecurringFormSheet, formFromTx } from '@/features/recurring/RecurringFormSheet';
import { EventFormSheet } from '@/features/events/EventsScreen';
import { EventPickList } from '@/features/events/EventPickList';
import { useRecurringOps, useRecurrings } from '@/application/recurring';
import { canBeRecurringCost } from '@/domain/recurring';
import { useEvents } from '@/application/events';
import { RecurringVisual } from '@/features/recurring/RecurringVisual';
import { LOCALES, useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import { useData } from '@/app/data';
import { logActivity } from '@/application/activity';
import { settleSpaceReimbursements } from '@/application/catalogMaintenance';
import { countPreAnchorTx } from '@/application/loanBalance';
import { isLiability } from '@/features/accounts/accountTypes';
import { catName, useCategories } from '@/features/categories/useCategories';
import { fmtCents } from '@/lib/money';
import { cleanBankText, humanizeBankKeys, orDefaultLabel, txTitle } from '@/lib/text';
import { SearchableTitle } from './TitleSearch';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Pill } from '@/ui/primitives';
import { Sheet, hasOpenSheet } from '@/ui/Sheet';
import { givenCents, netAmountCents, netCreditCents, partNetCents, reimbursedInCats, totalReimbursedCents } from '@/domain/reimbursement';
import { EXPECTED_REIMBURSE_ID, REIMBURSED_ID, UNCATEGORIZED_ID, specialCatType, stampMovementSub } from '@/domain/categories';
import { cashWalletId, defaultFamilyFor } from '@/domain/defaultAccounts';
import { isEventMoney } from '@/domain/events';
import { primaryCatId } from '@/domain/splits';
import { scaleCatsTo, scaleSplitsTo } from '@/domain/txSlices';
import { ReviewPartDeck, partRecurringPrefill } from '@/features/review/ReviewScreen';
import { mirrorTxId, normalizeIban } from '@/domain/feedIds';
import { ReceiptSection } from '@/features/shopping/ReceiptSection';
import { BulkReceiptQueue } from '@/features/shopping/BulkReceiptQueue';
import { receiptsToVerify } from '@/features/shopping/receiptWalk';
import { useAttachableReceipts } from '@/application/connections';
import { useProposedMatches } from '@/application/receiptLinks';
import { EntryLinkSection } from './EntryLinkSection';
import { ReimburseSection } from './ReimburseSection';
import { ReadOnlyNote } from '@/features/spaces/ReadOnlyNote';
import { useCanEdit } from '@/app/useCanEdit';
import { SplitEditorSheet } from './SplitEditorSheet';
import { CatsSheet, catsAroundSingle, partCatsApplyPatch } from './PartCatsSheet';
import type { CatsApplyEntry } from './PartCatsSheet';
import { BulkCounterQueue, CounterMatchSheet, CounterpartySheet } from './TxKindSheet';
import { TxFormSheet } from './TxFormSheet';
import { DangerConfirmSheet } from '@/ui/DangerConfirmSheet';
import { kindOf } from '@/domain/txKind';
import { mintMirrorForExistingLink, removeMirrorForDeletedSource } from '@/application/mirrorMint';
import { pairWithExistingRow, releasePeerLeg } from '@/application/counterPair';
import { asSpaceAccount, writeTxTransform } from '@/db/joined';
import { accountStamp, counterTypesFor, movementCatFor } from '@/domain/txType';
import { merchantKey } from '@/domain/merchantKey';
import { resolveTxDetailBlocks } from './TxDetailCustomizeScreen';
import type { TxDetailBlockId } from './TxDetailCustomizeScreen';
import { TxRow } from '@/ui/TxRow';
import type { SpaceTx } from '@/application/transactions';
import type { AccountRow, EventRow, RecurringRow, TxSplit, TxSplitCat } from '@/db/types';

const DATE_FMT: Record<string, string> = { en: 'en-GB', nl: 'nl-NL', tr: 'tr-TR' };

// the name the SPACE gave the account, and under it its number: masked card, IBAN, or the bank's own name
// when that is a number and the space renamed it
function counterAccountFace(
  account: Pick<AccountRow, 'id' | 'name' | 'iban' | 'maskedNumber'>,
  spaceAccounts: readonly { id: string; name: string }[] | undefined,
): { name: string; number: string | null } {
  const display = spaceAccounts?.find((a) => a.id === account.id)?.name ?? account.name;
  const bankName = account.name.replaceAll(' ', '');
  const looksLikeNumber = /^[\d*]{6,}$/.test(bankName) || /^[A-Z]{2}\d{2}[A-Z\d]{8,}$/i.test(bankName);
  const number = account.maskedNumber ?? account.iban ?? (looksLikeNumber && display !== account.name ? account.name : null);
  return { name: display, number: number === display ? null : number };
}

// a container row opens its part's page; the settled Reimbursed slice and id-less legacy parts keep the editor (#200)
const partTargetId = (multi: boolean, slice: TxSplit | null, canOpen: boolean): string | null =>
  multi && canOpen && slice?.id && slice.catId !== REIMBURSED_ID ? slice.id : null;

// a part row shows what the part is WORTH (its own settled bookkeeping nets it, #228); a single category spans the whole tx
const sliceRowAmountCents = (
  partsMode: boolean,
  slice: { amountCents: number; cats?: TxSplitCat[] } | null,
  tx: { amountCents: number },
): number => {
  if (!slice) return Math.abs(tx.amountCents);
  return partsMode ? partNetCents(slice) : slice.amountCents;
};

/** on a container the rows ARE the parts and open the part's page; a single category opens the unified editor (#200) */
function CategorySlices({
  tx,
  cats,
  fallbackCat,
  fallbackColor,
  onEdit,
  onOpenPart,
}: Readonly<{
  tx: SpaceTx;
  cats: ReturnType<typeof useCategories>;
  fallbackCat: ReturnType<ReturnType<typeof useCategories>['byId']>;
  fallbackColor: string;
  /** absent = the category is locked: the row is inert and drops its chevron (#328) */
  onEdit?: () => void;
  onOpenPart?: (partId: string) => void;
}>) {
  const { t, lang } = useLang();
  // a container renders its PARTS; a whole row with its own category spread renders one row per entry, each a door
  // back into the cats editor (#211)
  const partsMode = !!tx.splits?.length;
  const spreadEntries = (tx.cats?.length ? tx.cats : [null]) as (TxSplit | null)[];
  const parts = partsMode ? tx.splits! : spreadEntries;
  const multi = partsMode && parts.length > 1;
  return (
    <div>
      {parts.map((slice, i) => {
        const rowCat = slice ? cats.byId(slice.catId) : fallbackCat;
        const rowColor = slice ? (rowCat.color ?? cats.byId(rowCat.parentId ?? '').color) : fallbackColor;
        const parentName = rowCat.parentId ? catName(cats.byId(rowCat.parentId), t) : t(`tx.type.${tx.txType}`);
        const partLabel = slice?.label ?? (multi ? `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}` : undefined);
        const partType = slice?.txType && slice.txType !== tx.txType ? slice.txType : undefined;
        // a spread part lists its real categories, not the settled bookkeeping (#228)
        const realSliceCats = slice?.cats?.filter((c) => c.catId !== REIMBURSED_ID);
        const spreadNames = realSliceCats?.length
          ? realSliceCats.map((c) => catName(cats.byId(c.catId), t)).join(' · ')
          : undefined;
        const openPartId = partTargetId(multi, slice, !!onOpenPart);
        return (
          <button
            key={slice?.id ?? (slice ? `${slice.catId}-${i}` : 'single')}
            data-testid={i === 0 ? 'tx-detail-category-row' : `tx-detail-cat-${slice?.catId}`}
            onClick={openPartId ? () => onOpenPart?.(openPartId) : onEdit}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3.5 text-left last:border-0"
          >
            <Icon name={rowCat.icon} size={20} color={rowColor ?? 'var(--m-ink-3)'} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px] text-ink">{multi ? partLabel : catName(rowCat, t)}</span>
              <span className="block truncate text-[11px] text-ink-4">
                {multi ? (spreadNames ?? catName(rowCat, t)) : parentName}
                {partType && (
                  <span className="text-accent-deep" data-testid={`tx-detail-part-type-${slice?.id ?? i}`}>
                    {' '}· {t(`tx.type.${partType}`)}
                  </span>
                )}
              </span>
            </span>
            {i === 0 && tx.needsReview === 1 && <Pill tone="warning">{t('tx.unreviewed')}</Pill>}
            <span className="m-num text-[13px] text-ink-2">
              {fmtCents(sliceRowAmountCents(partsMode, slice, tx), tx.currency, lang)}
            </span>
            {(openPartId || onEdit) && <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />}
          </button>
        );
      })}
    </div>
  );
}

/** the bank's counterparty is ALWAYS shown here as read-only metadata; a tap only opens the matched account's info (#220) */
function DetailFacts({
  tx,
  givenOut,
  counterAccountName,
  onOpenCounterAccount,
}: Readonly<{
  tx: SpaceTx;
  givenOut: number;
  counterAccountName?: string;
  /** absent = the plain-metadata rendering (part pages) */
  onOpenCounterAccount?: () => void;
}>) {
  const { t, lang } = useLang();
  if (!(totalReimbursedCents(tx) > 0 || givenOut > 0 || tx.titleOverride || tx.description || tx.counterIban)) return null;
  const counterFace = counterAccountName ?? tx.counterIban;
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
        {/* the counterparty the BANK named, always shown as metadata (#220); the property row owns the plain name (#228) */}
        {tx.counterIban && (
          <button
            data-testid="tx-detail-original-counter"
            disabled={!counterAccountName || !onOpenCounterAccount}
            onClick={onOpenCounterAccount}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left text-[14px] last:border-0"
          >
            <Icon name="swap-horizontal" size={18} color="var(--m-ink-3)" />
            <span className="shrink-0 text-ink-3">{t('tx.originalCounterparty')}</span>
            <span className="m-num min-w-0 flex-1 truncate text-right text-ink">
              <span className={counterAccountName ? 'text-accent-deep' : 'font-mono text-[12px]'}>{counterFace}</span>
              {counterAccountName && (
                <span className="block truncate font-mono text-[11px] text-ink-4">{tx.counterIban}</span>
              )}
            </span>
            {counterAccountName && <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />}
          </button>
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

const similarTo = (allTxs: SpaceTx[] | undefined, tx: SpaceTx, differs: (item: SpaceTx) => boolean): SpaceTx[] =>
  (allTxs ?? []).filter((item) => item.id !== tx.id && merchantKey(item.merchant) === merchantKey(tx.merchant) && differs(item));

// a pre-anchor payment on a manual loan never counted in may be counted by hand once; `<=` mirrors countsTowardLoan
// only a REAL other leg (bank twin, picked row) disqualifies: the row's own gated mint moved nothing for pre-anchor dates
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

/** the count-it-in offer lives on both legs: the payment's counterparty row and the loan's generated leg (#509) */
const loanCountOffer = (
  tx: SpaceTx,
  account: AccountRow | undefined,
  linkedAccount: AccountRow | undefined,
  peer: SpaceTx | undefined,
): { source: SpaceTx; loan: AccountRow } | null => {
  if (linkedAccount && offersLoanCount(tx, linkedAccount)) return { source: tx, loan: linkedAccount };
  if (account && peer && tx.id === mirrorTxId(peer.id) && offersLoanCount(peer, account)) return { source: peer, loan: account };
  return null;
};

// deleting takes the mint along: the manual counter's mirror is tombstoned and its balance comes back;
// bank-linked balances stay the bank's
async function deleteManualTxRow(
  store: ReturnType<typeof useData>['store'],
  repo: ReturnType<typeof useData>['repo'],
  spaceId: string,
  tx: SpaceTx,
  account: AccountRow | undefined,
): Promise<void> {
  await removeMirrorForDeletedSource(store, repo, tx, tx.linkedAccountId).catch(() => undefined);
  if (account && account.source !== 'connector') {
    const fresh = await store.get('account', account.id);
    if (fresh?.deleted === 0) {
      await repo.upsert('account', tx.spaceId, fresh.id, { balanceCents: fresh.balanceCents - tx.amountCents });
    }
  }
  await repo.remove('transaction', tx.spaceId, tx.id);
  // #617: what it reimbursed, or was reimbursed by, stops reading as settled now — not at the next start
  await settleSpaceReimbursements(store, repo, spaceId).catch(() => undefined);
  void logActivity(store, repo, spaceId, 'txDelete', txTitle(tx));
}

// heals a pre-engine link's missing leg; an already-minted but unpaired leg gets its reciprocal back too (#237)
async function healMissingMirror(
  store: ReturnType<typeof useData>['store'],
  repo: ReturnType<typeof useData>['repo'],
  tx: SpaceTx,
): Promise<void> {
  const mid = await mintMirrorForExistingLink(store, repo, tx, tx.linkedAccountId, tx.transferPeerId);
  if (!mid) return;
  await writeTxTransform(repo, tx, { transferPeerId: mid });
  const mirror = await store.get('transaction', mid);
  if (mirror?.deleted === 0 && !mirror.transferPeerId) {
    await writeTxTransform(repo, mirror, { transferPeerId: tx.id });
  }
}

// any peered row shows its pair: the wallet story's purchase leg keeps its own category and type (#237)
// the peer id is the EFFECTIVE one: a one-way pair still reads as peered while the heal writes the reciprocal
function transferPairState(
  tx: Pick<SpaceTx, 'txType' | 'linkedAccountId'>,
  effectivePeerId: string | undefined,
  linkedAccount: { source: string } | undefined,
): 'peered' | 'awaiting' | 'offerCreate' | null {
  if (effectivePeerId) return 'peered';
  if (kindOf(tx.txType) !== 'transfer' || !tx.linkedAccountId) return null;
  if (!linkedAccount) return null;
  // manual counter: the other side can be created right here; a feed
  // counter's real row arrives with the bank — the matcher claims it
  return linkedAccount.source === 'manual' ? 'offerCreate' : 'awaiting';
}

function TransferPeerRow({
  t,
  lang,
  peer,
  accountName,
  onOpen,
  onUnpair,
}: Readonly<{
  t: TFunc;
  lang: ReturnType<typeof useLang>['lang'];
  peer: SpaceTx | undefined;
  accountName: string | undefined;
  /** absent = the other leg is out of this space's view: a blind jump landed on an empty detail (#255) */
  onOpen?: () => void;
  onUnpair?: () => void;
}>) {
  const face = peer ? (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-[10px] font-semibold tracking-wide text-accent-deep uppercase">
          {t('tx.pairedCounterpart')}
        </span>
        <span className="block truncate text-[14px] text-ink">{txTitle(peer)}</span>
        <span className="block truncate text-[11px] text-ink-4">
          {peer.date}
          {accountName ? ` · ${accountName}` : ''}
        </span>
      </span>
      <span className="m-num shrink-0 text-[14px] font-semibold text-ink">
        {fmtCents(peer.amountCents, peer.currency, lang, { sign: true })}
      </span>
    </>
  ) : (
    <span className="text-[14px] font-medium text-accent-deep">{t('tx.pairedCounterpart')}</span>
  );
  return (
    <>
      <div className="mx-4 h-px bg-line-2" />
      <div className="flex w-full items-center gap-3 px-4 py-3">
        <Icon name="swap-horizontal" size={20} color="var(--m-ink-3)" />
        {onOpen ? (
          <button
            data-testid="tx-detail-peer"
            onClick={onOpen}
            className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
          >
            {face}
          </button>
        ) : (
          <div data-testid="tx-detail-peer" className="flex min-w-0 flex-1 items-center gap-3 text-left">
            {face}
          </div>
        )}
        {onUnpair && (
          <button
            aria-label={t('tx.unpair')}
            data-testid="tx-detail-unpair"
            onClick={onUnpair}
            className="m-tap flex h-8 w-8 items-center justify-center border-none bg-transparent text-ink-4"
          >
            <Icon name="link-off" size={16} />
          </button>
        )}
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

      <Sheet open={open} onOpenChange={setOpen} title={t('tx.bulkOffer', { n: selected.size })} height={760} dragHandle>
        <SelectAllRow
          total={targets.length}
          selected={targets.filter((item) => selected.has(item.id)).length}
          onChange={(next) => onChange(next ? new Set(targets.map((item) => item.id)) : new Set())}
          testId="tx-detail-bulk-select-all"
          className="mb-1"
        />
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

/** the bank's merchant never changes; clearing the field (or typing the original) removes the override */
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
  if (open && !last.current) setDraft(value);
  last.current = open;

  return (
    // 'form' height: on iOS the sheet lifts by the keyboard height and the compact one rose off the screen
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

// the bank's counterparty is read-only metadata on the Details block; the category editor's entries own the links (#220)

function splitDoorModeFor(multiPart: boolean, categoryLocked: boolean): 'row' | 'manage' | 'none' {
  if (multiPart) return 'manage';
  return categoryLocked ? 'none' : 'row';
}

// non-container rows only: parts own their links; the event door covers every kind of event money (#213, #448)
function DetailActionsCard({
  tx,
  multiPart,
  splitDoorMode,
  recurrings,
  events,
  onSplitDoor,
  onOpenRecurring,
  onOpenEvent,
}: Readonly<{
  tx: SpaceTx;
  multiPart: boolean;
  splitDoorMode: 'row' | 'manage' | 'none';
  recurrings: readonly { id: string; name: string }[] | undefined;
  events: readonly { id: string; name: string }[] | undefined;
  onSplitDoor: () => void;
  onOpenRecurring: () => void;
  onOpenEvent: () => void;
}>) {
  const { t } = useLang();
  // funding is recurring-shaped money too (#264); a refund files under an expense category and is no cost (#649)
  const recurringRow = (tx.txType === 'expense' || tx.txType === 'funding') && canBeRecurringCost(tx.amountCents) && !multiPart;
  // received money joins an event too; only a movement between own accounts has none (#448)
  const eventRow = isEventMoney(tx.txType) && !multiPart;
  if (splitDoorMode === 'none' && !recurringRow && !eventRow) return null;
  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('tx.actionsSection')}</div>
      <div className="overflow-hidden rounded-card border border-line bg-surface">
        {splitDoorMode !== 'none' && (
          <button
            data-testid={splitDoorMode === 'row' ? 'tx-detail-split-row' : 'tx-detail-manage-splits'}
            onClick={onSplitDoor}
            className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
          >
            <Icon name="call-split" size={20} color="var(--m-ink-3)" />
            <span className="flex-1 truncate">{t(splitDoorMode === 'row' ? 'split.title' : 'review.manageSplits')}</span>
            {/* rows whose tap opens a sheet wear the chevron; the pencil is for in-place edits (#328) */}
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        )}
        {recurringRow && (
          <>
            {splitDoorMode !== 'none' && <div className="mx-4 h-px bg-line-2" />}
            <button
              data-testid="tx-detail-recurring-row"
              onClick={onOpenRecurring}
              className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
            >
              <Icon name="autorenew" size={20} color="var(--m-ink-3)" />
              <span className="flex-1 truncate">
                {tx.recurringId
                  ? (recurrings?.find((r) => r.id === tx.recurringId)?.name ?? t('recurring.linkTitle'))
                  : t('recurring.linkTitle')}
              </span>
              {!tx.recurringId && <span className="text-xs text-ink-4">{t('recurring.linkNone')}</span>}
              <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
            </button>
          </>
        )}
        {eventRow && (
          <>
            {(splitDoorMode !== 'none' || recurringRow) && <div className="mx-4 h-px bg-line-2" />}
            <button
              data-testid="tx-detail-event-row"
              onClick={onOpenEvent}
              className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3.5 text-left text-[15px] text-ink"
            >
              <Icon name="party-popper" size={20} color="var(--m-ink-3)" />
              <span className="flex-1 truncate">
                {tx.eventId ? (events?.find((e) => e.id === tx.eventId)?.name ?? t('events.linkTitle')) : t('events.linkTitle')}
              </span>
              {!tx.eventId && <span className="text-xs text-ink-4">{t('events.linkNone')}</span>}
              <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
            </button>
          </>
        )}
      </div>
    </>
  );
}

/** a split container is never a bulk-recategorize target: its parts own their categories (#143) */
const isMultiPartRow = (item: Pick<SpaceTx, 'splits'>): boolean =>
  (item.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID).length > 1;
const catBulkTargets = (
  allTxs: SpaceTx[] | undefined,
  tx: SpaceTx,
  offer: { catId: string } | null,
): SpaceTx[] =>
  // a sibling with its own category spread made a deliberate decision: single-category bulk never overwrites it (#211)
  (offer ? similarTo(allTxs, tx, (item) => !isMultiPartRow(item) && !item.cats?.length && item.catId !== offer.catId) : []);
// a fresh split copies onto same-merchant splitless siblings; exact euros reach only the same amount,
// a percentage split scales to any (#141)
const splitBulkTargets = (allTxs: SpaceTx[] | undefined, tx: SpaceTx, source: readonly TxSplit[]): SpaceTx[] => {
  const pctSplit = source.some((s) => s.pct != null);
  const totalCents = source.reduce((sum, s) => sum + Math.abs(s.amountCents), 0);
  return similarTo(
    allTxs,
    tx,
    (item) => (item.splits ?? []).length === 0 && !item.cats?.length && (pctSplit || Math.abs(item.amountCents) === totalCents),
  );
};

// one category on a whole row rewrites its partition: a spread clears (settled: re-forms around the pick),
// legacy splits clear (#211)
function singleCatPartitionFields(
  tx: Pick<SpaceTx, 'amountCents' | 'cats' | 'splits'>,
  multiPart: boolean,
  settledCents: number,
  catId: string,
): Partial<{ cats: never; splits: never }> {
  if (multiPart) return {};
  if (settledCents > 0) {
    const rest = Math.max(0, Math.abs(tx.amountCents) - settledCents);
    return {
      cats: [...(rest > 0 ? [{ catId, amountCents: rest }] : []), { catId: REIMBURSED_ID, amountCents: settledCents }] as never,
      ...(tx.splits?.length ? { splits: null as never } : {}),
    };
  }
  return {
    ...(tx.cats?.length ? { cats: null as never } : {}),
    ...(tx.splits?.length ? { splits: null as never } : {}),
  };
}

// the peer is fetched from the STORE when the live snapshot hasn't emitted it: a slow liveQuery left it dangling (CI flake)

interface RowEntryDeps {
  tx: SpaceTx;
  cats: ReturnType<typeof useCategories>;
  store: ReturnType<typeof useData>['store'];
  repo: ReturnType<typeof useData>['repo'];
  spaceId: string;
  transform: ReturnType<typeof useTxTransform>;
  allTxs: SpaceTx[] | undefined;
  reimbNow: number;
  bulkArmedReimbRef: { current: number };
  singleCatFields: (catId: string) => Partial<{ cats: never; splits: never }>;
  setSplitBulk: (v: TxSplit[] | null) => void;
  setCatsBulk: (v: TxSplitCat[] | null) => void;
  setBulkOffer: (v: BulkOfferState | null) => void;
  setBulkSelected: (v: ReadonlySet<string>) => void;
}

// the offer remembers the entry's counter story: a plain link bulk-applies,
// a SPECIFIC pick runs the per-sibling match queue (#268)
interface BulkOfferState {
  catId: string;
  count: number;
  link?: { accountId: string; viaPeer: boolean };
}

// one entry decides the row; its counterparty was answered in the editor or property row, so nothing asks afterwards (#228)
// a bare ◆ entry keeps the deliberate bare story; a plain pick arms the #141 bulk offer
async function writeRowSingleEntry(deps: RowEntryDeps, entry: CatsApplyEntry): Promise<void> {
  const { tx } = deps;
  // the editor owns the link story: a bare entry on a linked row is a detach (#218)
  const linkChanged = (entry.linkedAccountId ?? undefined) !== (tx.linkedAccountId ?? undefined);
  // a pick can arrive on the account the row already links (re-picking Paypal):
  // the peer must land regardless of linkChanged (#237)
  const foreignPeer =
    entry.transferPeerId && entry.transferPeerId !== tx.transferPeerId ? entry.transferPeerId : undefined;
  // a re-link away from a peered leg, or a re-pick onto a new peer, releases the old pair first:
  // a stale peer keeps collapsing the pair in the list
  const unpeer = (linkChanged || !!foreignPeer) && !!tx.transferPeerId;
  if (unpeer) void releasePeerLeg(deps.store, deps.repo, deps.spaceId, tx, deps.allTxs);
  let peerField: { transferPeerId?: string | null } = {};
  if (foreignPeer) peerField = { transferPeerId: foreignPeer };
  else if (unpeer) peerField = { transferPeerId: null };
  await deps.transform(
    tx,
    {
      catId: entry.catId,
      needsReview: 0,
      ...deps.singleCatFields(entry.catId),
      ...(linkChanged ? { linkedAccountId: (entry.linkedAccountId ?? null) as never } : {}),
      ...(peerField as Record<string, never>),
    },
    'txCategory',
  );
  if (foreignPeer) await pairWithExistingRow(deps.store, deps.repo, deps.spaceId, tx, foreignPeer, deps.allTxs);
  // reaches EVERYTHING of this merchant, reviewed included; never the settlement category nor the Uncategorized placeholder
  const similar =
    entry.catId === REIMBURSED_ID || entry.catId === UNCATEGORIZED_ID
      ? []
      : similarTo(deps.allTxs, tx, (item) => !isMultiPartRow(item) && !item.cats?.length && item.catId !== entry.catId);
  deps.bulkArmedReimbRef.current = deps.reimbNow;
  deps.setSplitBulk(null);
  deps.setCatsBulk(null);
  deps.setBulkOffer(
    similar.length > 0
      ? {
          catId: entry.catId,
          count: similar.length,
          link: entry.linkedAccountId ? { accountId: entry.linkedAccountId, viaPeer: !!foreignPeer } : undefined,
        }
      : null,
  );
  deps.setBulkSelected(new Set(similar.map((item) => item.id)));
}

// ONE entry routes through the single writer; several land the spread in one write with the settled `reimbursed` entry
// re-attached and the row-level link cleared: a spread means regular categories (#228)
function applyRowCats(
  deps: {
    tx: SpaceTx;
    settledCents: number;
    transform: ReturnType<typeof useTxTransform>;
    applySingle: (entry: CatsApplyEntry) => void;
    armCatsBulk: (entries: TxSplitCat[]) => void;
  },
  entries: CatsApplyEntry[],
): void {
  if (entries.length === 1) {
    deps.applySingle(entries[0]);
    return;
  }
  const full =
    deps.settledCents > 0 ? [...entries, { catId: REIMBURSED_ID, amountCents: deps.settledCents }] : entries;
  const primary = entries.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), entries[0]);
  void deps.transform(
    deps.tx,
    {
      cats: full,
      catId: primary.catId,
      needsReview: 0,
      ...(deps.tx.splits?.length ? { splits: null as never } : {}),
      ...(deps.tx.linkedAccountId ? { linkedAccountId: null as never } : {}),
    },
    'txCategory',
  );
  deps.armCatsBulk(entries);
}

const catsBulkTargets = (allTxs: SpaceTx[] | undefined, tx: SpaceTx, entries: readonly TxSplitCat[]): SpaceTx[] => {
  const pctSpread = entries.every((e) => e.pct != null);
  const totalCents = entries.reduce((sum, e) => sum + e.amountCents, 0);
  return similarTo(
    allTxs,
    tx,
    (item) => (item.splits ?? []).length === 0 && !item.cats?.length && (pctSpread || Math.abs(item.amountCents) === totalCents),
  );
};

async function writeCatsBulk(
  transform: ReturnType<typeof useTxTransform>,
  entries: readonly TxSplitCat[],
  picked: readonly SpaceTx[],
): Promise<number> {
  let n = 0;
  for (const item of picked) {
    const scaled = scaleCatsTo(entries as NonNullable<TxSplit['cats']>, Math.abs(item.amountCents));
    if (!scaled || scaled.length < 2) continue;
    const primary = scaled.reduce((best, e) => (e.amountCents > best.amountCents ? e : best), scaled[0]);
    await transform(item, { cats: scaled, catId: primary.catId, needsReview: 0 }, null);
    n++;
  }
  return n;
}

/** scaleSplitsTo drops per-transaction stories */
async function writeSplitBulk(
  transform: ReturnType<typeof useTxTransform>,
  mintId: () => string,
  source: readonly TxSplit[],
  picked: readonly SpaceTx[],
): Promise<number> {
  let n = 0;
  for (const item of picked) {
    const scaled = scaleSplitsTo(source, Math.abs(item.amountCents), mintId);
    if (scaled.length < 2) continue;
    // one history line for the whole batch (caller logs); the explicit cats null version-stamps the container (#211)
    await transform(item, { splits: scaled, catId: primaryCatId(scaled) ?? item.catId, cats: null as never, needsReview: 0 }, null);
    n++;
  }
  return n;
}
const titleBulkTargets = (
  allTxs: SpaceTx[] | undefined,
  tx: SpaceTx,
  bulk: { title: string } | null,
): SpaceTx[] => (bulk ? similarTo(allTxs, tx, (item) => txTitle(item) !== bulk.title) : []);
const normalizedCounterIban = (tx: SpaceTx | undefined): string | undefined =>
  tx?.counterIban ? normalizeIban(tx.counterIban) : undefined;
const givenOutFor = (tx: SpaceTx | undefined, allTxs: readonly SpaceTx[] | undefined): number =>
  tx && tx.amountCents > 0 ? givenCents(allTxs ?? [], tx.id) : 0;
const findPartView = (parts: readonly TxSplit[], partParam: string | undefined): TxSplit | undefined =>
  partParam ? parts.find((s) => s.id === partParam) : undefined;
const valuesEditorValue = (
  stage: TxSplit[] | null,
  multiPart: boolean,
  parts: TxSplit[],
): TxSplit[] | undefined => stage ?? (multiPart ? parts : undefined);

function detailTrailingAction(
  isPart: boolean,
  importRef: string | undefined,
  t: TFunc,
  onRename: () => void,
  onEdit: () => void,
): ReactNode {
  if (isPart) {
    return (
      <IconButton label={t('tx.renameTitle')} testId="tx-part-rename" onClick={onRename}>
        <Icon name="pencil-outline" size={20} />
      </IconButton>
    );
  }
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

const derivedPartLabel = (tx: SpaceTx, parts: readonly TxSplit[], partView: TxSplit | undefined, t: TFunc): string =>
  partView ? `${txTitle(tx)} – ${t('split.partN', { n: parts.indexOf(partView) + 1 })}` : '';

function detailScreenTitle(tx: SpaceTx, parts: readonly TxSplit[], partView: TxSplit | undefined, t: TFunc): string {
  if (!partView) return txTitle(tx);
  return orDefaultLabel(partView.label, derivedPartLabel(tx, parts, partView, t));
}

// a pair pointer may be the peer row, a container whose PART holds the other end, or a part-mirror source key
// "rowId:partId" (':' never occurs in real ids); resolve to a real nav target, never an empty detail (#255)
interface ResolvedPairPeer {
  row: SpaceTx;
  /** set when the other leg is a PART of `row` */
  part?: TxSplit;
  nav: { txId: string; part?: string };
}
function resolvePairPeer(
  txId: string,
  peerId: string | undefined,
  allTxs: readonly SpaceTx[] | undefined,
): ResolvedPairPeer | null {
  if (!peerId || !allTxs) return null;
  const direct = allTxs.find((row) => row.id === peerId && row.deleted === 0);
  if (direct) {
    // a part-level pair's reciprocal points at the CONTAINER row — the
    // real other leg is the part pointing back here
    const part = direct.splits?.find((s) => s.transferPeerId === txId);
    return { row: direct, part, nav: { txId: direct.id, ...(part?.id ? { part: part.id } : {}) } };
  }
  const colon = peerId.indexOf(':');
  if (colon <= 0) return null;
  const owner = allTxs.find((row) => row.id === peerId.slice(0, colon) && row.deleted === 0);
  const part = owner?.splits?.find((s) => s.id === peerId.slice(colon + 1));
  return owner && part?.id ? { row: owner, part, nav: { txId: owner.id, part: part.id } } : null;
}

function pairPeerFace(resolved: ResolvedPairPeer, t: TFunc): SpaceTx {
  const { row, part } = resolved;
  if (!part) return row;
  const parts = (row.splits ?? []).filter((s) => s.catId !== REIMBURSED_ID);
  return {
    ...row,
    amountCents: (row.amountCents < 0 ? -1 : 1) * Math.abs(part.amountCents),
    merchant: orDefaultLabel(part.label, derivedPartLabel(row, parts, part, t)),
    titleOverride: undefined,
  };
}

function writePartLabel(
  transform: ReturnType<typeof useTxTransform>,
  tx: SpaceTx,
  partView: TxSplit | undefined,
  defaultLabel: string,
  raw: string,
): void {
  if (!partView) return;
  const trimmed = raw.trim();
  const label = trimmed && trimmed !== defaultLabel ? trimmed : undefined;
  const nextSplits = (tx.splits ?? []).map((s) => (s.id === partView.id ? { ...s, label } : s));
  void transform(tx, { splits: nextSplits });
}

function renameSheetProps(
  tx: SpaceTx,
  partView: TxSplit | undefined,
  partDefault: string,
  savePart: (raw: string) => void,
  saveTitle: (raw: string) => void,
): { original: string; value: string; onSave: (raw: string) => void } {
  if (partView) {
    return { original: partDefault, value: orDefaultLabel(partView.label, partDefault), onSave: savePart };
  }
  return { original: cleanBankText(tx.merchant), value: txTitle(tx), onSave: saveTitle };
}

/** the only hold on Apply: every part has a real category; a refused Apply marks the offenders (#126) */
const stagedSplitComplete = (stage: TxSplit[] | null): boolean =>
  !!stage && stage.every((s) => s.catId !== UNCATEGORIZED_ID);

/** the settled Reimbursed slice keeps the gross partition when it exists */
function writeUnsplit(
  transform: ReturnType<typeof useTxTransform>,
  tx: SpaceTx,
  fallbackCatId: string,
  settledCents: number,
  catId: string,
): void {
  const cat = catId !== UNCATEGORIZED_ID ? catId : fallbackCatId;
  // #260: un-splitting is a deliberate category decision — reviewed
  if (settledCents > 0) {
    // the parts' settled bookkeeping folds back into the row's own cats (#228)
    const rest = Math.max(0, Math.abs(tx.amountCents) - settledCents);
    void transform(tx, {
      cats: [...(rest > 0 ? [{ catId: cat, amountCents: rest }] : []), { catId: REIMBURSED_ID, amountCents: settledCents }],
      splits: null as never,
      catId: cat,
      needsReview: 0,
    });
  } else {
    void transform(tx, { splits: null as never, catId: cat, needsReview: 0 });
  }
}

/** values-only (categories have their own editor): Done only STAGES; the completion deck's Apply is the ONE write (#211) */
function DetailSplitSheets({
  tx,
  splitOpen,
  setSplitOpen,
  editorValue,
  allowedCatIds,
  unsplitTo,
  unsplitFallbackCat,
  splitStage,
  setSplitStage,
  completeOpen,
  setCompleteOpen,
  activeEvents,
  lockedKind,
  recurrings,
  attention,
  openValuesEditor,
  applyStagedSplit,
}: Readonly<{
  tx: SpaceTx;
  splitOpen: boolean;
  setSplitOpen: (open: boolean) => void;
  editorValue: TxSplit[] | undefined;
  allowedCatIds?: readonly string[];
  unsplitTo: (catId: string) => void;
  unsplitFallbackCat: string;
  splitStage: TxSplit[] | null;
  setSplitStage: (stage: TxSplit[] | null) => void;
  completeOpen: boolean;
  setCompleteOpen: (open: boolean) => void;
  activeEvents: readonly EventRow[];
  lockedKind: boolean;
  recurrings: readonly Pick<RecurringRow, 'id' | 'name' | 'logo' | 'icon' | 'kind'>[];
  attention: boolean;
  openValuesEditor: () => void;
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
        value={editorValue}
        onApplySingle={unsplitTo}
        onApply={(splits) => {
          if (splits?.length) {
            setSplitStage(splits);
            setCompleteOpen(true);
          } else {
            unsplitTo(unsplitFallbackCat);
          }
        }}
      />
      {/* drafted-until-complete: every part takes its category, type and event here; Apply is the ONE write (#126) */}
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
            recurrings={recurrings}
            attention={attention}
            onOpenValues={() => {
              setCompleteOpen(false);
              openValuesEditor();
            }}
            onSplits={(next) => setSplitStage([...next])}
          />
          {/* always tappable: a refused Apply marks the incomplete parts instead of sitting disabled */}
          <Button data-testid="split-apply" onClick={applyStagedSplit} disabled={!splitStage}>
            {t('split.applyAll')}
          </Button>
        </div>
      </Sheet>
    </>
  );
}

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
              {orDefaultLabel(slice.label, `${txTitle(tx)} – ${t('split.partN', { n: i + 1 })}`)}
              <span className="text-[11px] font-normal text-ink-4"> · {catName(sliceCat, t)}</span>
            </span>
            <span className="m-num text-[12px] text-ink-2">{fmtCents(partNetCents(slice), tx.currency, lang)}</span>
            {!self && <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />}
          </button>
        );
      })}
    </div>
  );
}

// write-through: the split is already complete; container-only facts (notes, reimbursements, receipts, delete)
// stay on the whole transaction (#126)
function PartDetailBody({
  tx,
  part,
  parts,
  accountName,
  ownStamp,
  activeEvents,
  allowedCatIds,
  onManageSplits,
  open,
}: Readonly<{
  tx: SpaceTx;
  part: TxSplit;
  parts: readonly TxSplit[];
  accountName: string | undefined;
  ownStamp: boolean;
  /** #537: every event, archived ones included (the picker labels them) */
  activeEvents: readonly EventRow[];
  allowedCatIds?: readonly string[];
  onManageSplits: () => void;
  open: OpenTx;
}>) {
  const { t, lang } = useLang();
  const cats = useCategories();
  const transform = useTxTransform();
  const navigate = useNavigate();
  const accounts = useSpaceAccounts();
  const [eventOpen, setEventOpen] = useState(false);
  const [recOpen, setRecOpen] = useState(false);
  const [recCreating, setRecCreating] = useState(false);
  const [eventCreating, setEventCreating] = useState(false);
  const recurrings = useRecurrings();
  const activeRecs = (recurrings ?? []).filter((r) => r.active === 1);
  const [spreadOpen, setSpreadOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [partMatchOpen, setPartMatchOpen] = useState(false);
  const { store, repo, spaceId } = useData();

  const sign = tx.amountCents < 0 ? -1 : 1;
  const partDirection: 'debit' | 'credit' = tx.amountCents < 0 ? 'debit' : 'credit';
  const partEvent = activeEvents.find((e) => e.id === part.eventId);
  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });
  // #197: a CREDIT container's part also FUNDS links that live on the expense rows
  const allTxs = useSpaceTransactions();
  const partLinks = (tx.reimbursements ?? []).filter((r) => r.partId === part.id);
  const givenLinks = (allTxs ?? []).flatMap((row) =>
    (row.reimbursements ?? [])
      .filter((r) => r.txId === tx.id && r.creditPartId === part.id)
      .map((r) => ({ rowId: row.id, amountCents: r.amountCents })),
  );
  const rowTitleOf = (id: string) => {
    const row = allTxs?.find((item) => item.id === id);
    return row ? txTitle(row) : id;
  };
  const rowDayOf = (id: string) => {
    const row = allTxs?.find((item) => item.id === id);
    return row ? new Date(row.date).toLocaleDateString(LOCALES[lang], { weekday: 'short', day: 'numeric', month: 'short' }) : '';
  };

  // no restriction on a split beyond the amounts; a deliberate edit here IS the review (#260)
  const patchPart = (patch: Partial<TxSplit>): void => {
    const nextSplits = (tx.splits ?? []).map((s) => (s.id === part.id ? { ...s, ...patch } : s));
    const nonReimb = nextSplits.filter((s) => s.catId !== REIMBURSED_ID);
    void transform(tx, { splits: nextSplits, catId: primaryCatId(nonReimb) ?? tx.catId, needsReview: 0 }, 'txCategory');
  };

  // pick refiles the category by the account's kind (bijection re-pick rule); settled `reimbursed` bookkeeping survives (#228)
  const partCounter = accounts?.find((a) => a.id === part.linkedAccountId);
  const partPeer = resolvePairPeer(tx.id, part.transferPeerId, allTxs);
  const partPeerFaceRow = partPeer ? pairPeerFace(partPeer, t) : undefined;
  const partPeerAccountName = partPeer ? accounts?.find((a) => a.id === partPeer.row.accountId)?.name : undefined;
  const partRealCats = (part.cats ?? []).filter((c) => c.catId !== REIMBURSED_ID);
  const partSettledCats = (part.cats ?? []).filter((c) => c.catId === REIMBURSED_ID);
  const partSigned = sign * Math.abs(part.amountCents);
  const pairPartPick = (pickedTxId: string): void => {
    void pairWithExistingRow(store, repo, spaceId, { id: tx.id, accountId: tx.accountId, amountCents: partSigned }, pickedTxId, allTxs);
  };
  const applyPartCounter = (picked: { id: string; type: AccountRow['type'] }, peer?: { txId: string }): void => {
    const derived = movementCatFor(picked.type, partSigned);
    patchPart({
      catId: derived,
      txType: specialCatType(derived),
      linkedAccountId: picked.id,
      transferPeerId: peer?.txId,
      cats: catsAroundSingle(part, derived),
    });
    if (peer) pairPartPick(peer.txId);
  };
  const removePartCounter = (): void =>
    patchPart({
      catId: UNCATEGORIZED_ID,
      txType: undefined,
      linkedAccountId: undefined,
      transferPeerId: undefined,
      cats: catsAroundSingle(part, UNCATEGORIZED_ID),
    });

  return (
    <>
      <div className="flex flex-col items-center py-6 text-center">
        <div className="m-num text-4xl text-ink" data-testid="tx-part-amount">
          {fmtCents(sign * partNetCents(part), tx.currency, lang, { sign: true })}
        </div>
        <div className="mt-1 text-sm text-ink-3">
          {fmtDay.format(new Date(tx.date))}
          {tx.time ? ` · ${tx.time}` : ''}
        </div>
        <div className="mt-1 text-[12px] text-ink-4">{txTitle(tx)}</div>
      </div>

      <div className="overflow-hidden rounded-card border border-line bg-surface">
        <div className="flex items-center gap-3 px-4 py-3.5 text-[15px] text-ink" data-testid="tx-part-account-row">
          <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1 truncate">{accountName ?? '—'}</span>
          <span className="text-xs text-ink-4">{t('txform.account')}</span>
        </div>
        {/* the counterparty is the PART's own property: removal resets the part's category (#228) */}
        <div className="mx-4 h-px bg-line-2" />
        <button
          data-testid="tx-part-counter-row"
          onClick={() => setCounterOpen(true)}
          disabled={ownStamp}
          className="m-tap flex w-full items-center gap-3 border-none bg-transparent px-4 py-3 text-left text-[15px] text-ink"
        >
          <Icon name="bank-transfer" size={20} color="var(--m-ink-3)" />
          <span className={`min-w-0 flex-1 truncate ${partCounter ? '' : 'text-ink-4'}`}>
            {partCounter?.name ?? t('tx.counterNone')}
          </span>
          <span className="text-xs text-ink-4">{t('tx.counterAccount')}</span>
          {!ownStamp && <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />}
        </button>
        {/* a PAIRED row's tap travels to the other side, the pencil re-opens the match sheet; unpaired, the tap opens it (#255) */}
        {partCounter && !ownStamp && (
          <>
            <div className="mx-4 h-px bg-line-2" />
            <div className="flex w-full items-center gap-3 px-4 py-3 text-[15px] text-ink">
              <Icon name="swap-horizontal" size={20} color="var(--m-ink-3)" />
              <button
                data-testid="tx-part-countertx-row"
                onClick={() => {
                  if (partPeer) open(partPeer.nav.txId, partPeer.nav.part ?? undefined);
                  else setPartMatchOpen(true);
                }}
                className="m-tap flex min-w-0 flex-1 items-center gap-3 border-none bg-transparent p-0 text-left"
              >
                {partPeerFaceRow ? (
                  <>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] text-ink">{txTitle(partPeerFaceRow)}</span>
                      <span className="block truncate text-[11px] text-ink-4">
                        {partPeerFaceRow.date}
                        {partPeerAccountName ? ` · ${partPeerAccountName}` : ''}
                      </span>
                    </span>
                    <span className="m-num shrink-0 text-[14px] font-semibold text-ink">
                      {fmtCents(partPeerFaceRow.amountCents, partPeerFaceRow.currency, lang, { sign: true })}
                    </span>
                  </>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-ink-4">{t('tx.awaitingCounterpart')}</span>
                )}
              </button>
              <span className="shrink-0 text-xs text-ink-4">{t('tx.counterTxRow')}</span>
              <button
                aria-label={t('action.edit')}
                data-testid="tx-part-countertx-edit"
                onClick={() => setPartMatchOpen(true)}
                className="m-tap flex h-8 w-8 shrink-0 items-center justify-center border-none bg-transparent p-0 text-ink-4"
              >
                <Icon name="pencil-outline" size={14} />
              </button>
            </div>
          </>
        )}
      </div>

      {/* opens the whole-transaction category editor scoped to this part; the counter lives in the property row (#228) */}
      <div className="mt-3 overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-part-category">
        {(partRealCats.length ? partRealCats : [null]).map((entry, i) => {
          const rowCat = cats.byId(entry?.catId ?? part.catId);
          const rowColor = rowCat.color ?? cats.byId(rowCat.parentId ?? '').color;
          return (
            <button
              key={entry ? `${entry.catId}-${i}` : 'single'}
              data-testid={i === 0 ? 'tx-part-category-row' : `tx-part-cat-${i}`}
              onClick={() => setSpreadOpen(true)}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3.5 text-left last:border-0"
            >
              <Icon name={rowCat.icon} size={20} color={rowColor ?? 'var(--m-ink-3)'} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] text-ink">{catName(rowCat, t)}</span>
                {!entry && rowCat.parentId && (
                  <span className="block truncate text-[11px] text-ink-4">{catName(cats.byId(rowCat.parentId), t)}</span>
                )}
              </span>
              <span className="m-num text-[13px] text-ink-2">
                {fmtCents(entry ? entry.amountCents : partNetCents(part), tx.currency, lang)}
              </span>
              <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
            </button>
          );
        })}
        {partSettledCats.map((entry, i) => (
          <button
            key={`settled-${entry.catId}-${entry.amountCents}`}
            data-testid={`tx-part-cat-settled-${i}`}
            onClick={() => setSpreadOpen(true)}
            className="m-tap flex w-full items-center gap-3 border-t border-line-2 bg-transparent px-4 py-3.5 text-left opacity-60"
          >
            <Icon name={cats.byId(entry.catId).icon} size={20} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate text-[15px] text-ink-2">{catName(cats.byId(entry.catId), t)}</span>
            <span className="m-num text-[13px] text-ink-3">{fmtCents(entry.amountCents, tx.currency, lang)}</span>
            <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
          </button>
        ))}
      </div>

      <button
        data-testid="tx-part-rec"
        onClick={() => setRecOpen(true)}
        className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left text-[14px] text-ink"
      >
        <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">
          {activeRecs.find((rec) => rec.id === part.recurringId)?.name ?? t('recurring.linkNone')}
        </span>
        <span className="text-[11px] text-ink-4">{t('recurring.linkTitle')}</span>
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>

      <button
        data-testid="tx-part-event"
        onClick={() => setEventOpen(true)}
        className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left text-[14px] text-ink"
      >
        <Icon name="party-popper" size={18} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">{partEvent?.name ?? t('events.linkNone')}</span>
        <span className="text-[11px] text-ink-4">{t('events.linkTitle')}</span>
        <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />
      </button>

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

      {/* links born here target THIS part; the whole pair still shows on the container */}
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
        {/* links only: the netted headline and the facts card's original amount carry the money story (#231) */}
        {/* reimbursement rows go STRAIGHT to the linked transaction, parts too (#237) */}
        {partLinks.map((linkRow) => (
          <button
            key={`${linkRow.txId}-${linkRow.partId}`}
            data-testid={`tx-part-reimb-${linkRow.txId}`}
            onClick={() => open(linkRow.txId)}
            className="m-tap flex w-full items-center gap-3 border-x-0 border-t-0 border-b border-line-2 bg-transparent px-4 py-2.5 text-left text-[13px] last:border-0"
          >
            <Icon name="cash-refund" size={16} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">{rowTitleOf(linkRow.txId)}</span>
              <span className="block text-[11px] text-ink-4">{rowDayOf(linkRow.txId)}</span>
            </span>
            <span className="m-num text-ink-2">{fmtCents(linkRow.amountCents, tx.currency, lang)}</span>
          </button>
        ))}
        {givenLinks.map((given) => (
          <button
            key={`out-${given.rowId}`}
            data-testid={`tx-part-given-${given.rowId}`}
            onClick={() => open(given.rowId)}
            className="m-tap flex w-full items-center gap-3 border-x-0 border-t-0 border-b border-line-2 bg-transparent px-4 py-2.5 text-left text-[13px] last:border-0"
          >
            <Icon name="cash-refund" size={16} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-ink">{rowTitleOf(given.rowId)}</span>
              <span className="block text-[11px] text-ink-4">{rowDayOf(given.rowId)}</span>
            </span>
            <span className="m-num text-ink-2">{fmtCents(-given.amountCents, tx.currency, lang, { sign: true })}</span>
          </button>
        ))}
        {partLinks.length === 0 && givenLinks.length === 0 && <div className="px-4 py-3" />}
      </div>

      {/* a deliberate duplicate of the parent's bank facts: no trip to the container needed (#199) */}
      <DetailFacts tx={tx} givenOut={givenOutFor(tx, allTxs)} />

      <div className="m-cap mt-5 mb-1 px-1">{t('split.title')}</div>
      <PartSiblingRows
        tx={tx}
        parts={parts}
        currentId={part.id}
        onOpen={(partId) => open(tx.id, partId)}
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
        onClick={() => open(tx.id)}
        className="m-tap mt-2 flex w-full items-center justify-center gap-1.5 rounded-card border border-line bg-surface px-4 py-2.5 text-[13px] font-medium text-ink"
      >
        <Icon name="receipt-text-outline" size={15} />
        {t('tx.partWhole')}
      </button>

      <CounterpartySheet
        open={counterOpen}
        onOpenChange={setCounterOpen}
        excludeAccountId={tx.accountId}
        currentLinkedId={part.linkedAccountId}
        defaultFamily={specialCatType(part.catId) ? (defaultFamilyFor(part.catId) ?? undefined) : undefined}
        counterTypes={specialCatType(part.catId) ? counterTypesFor(part.catId) : undefined}
        anchor={{ id: tx.id, amountCents: partSigned, date: tx.date }}
        onChoose={(picked, peer) => applyPartCounter(picked, peer)}
        onDetach={part.linkedAccountId ? removePartCounter : undefined}
      />
      {partCounter && (
        <CounterMatchSheet
          open={partMatchOpen}
          onOpenChange={setPartMatchOpen}
          target={{ id: partCounter.id, name: partCounter.name }}
          anchor={{ id: tx.id, amountCents: partSigned, date: tx.date }}
          rows={allTxs ?? []}
          onWait={part.transferPeerId ? () => patchPart({ transferPeerId: undefined }) : undefined}
          onPick={(pickedTxId) => {
            patchPart({ transferPeerId: pickedTxId });
            pairPartPick(pickedTxId);
          }}
        />
      )}
      <CatsSheet
        open={spreadOpen}
        onOpenChange={setSpreadOpen}
        subject={part}
        currency={tx.currency}
        direction={partDirection}
        txType={tx.txType}
        allowedCatIds={allowedCatIds}
        // part spreads keep the chosen %/€ shape too, so the editor reopens as it was left (#216)
        includePct
        excludeAccountId={tx.accountId}
        askDisabled={ownStamp}
        onApply={(entries) => patchPart(partCatsApplyPatch(part, entries))}
      />
      <Sheet
        open={recOpen}
        onOpenChange={setRecOpen}
        title={t('recurring.linkTitle')}
        size="form"
        dragHandle
      >
        <div className="pt-1" data-testid="tx-part-rec-list">
          <button
            data-testid="tx-part-rec-none"
            onClick={() => {
              patchPart({ recurringId: undefined });
              setRecOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink-2"
          >
            <Icon name="close-circle-outline" size={18} color="var(--m-ink-4)" />
            <span className="min-w-0 flex-1 truncate">{t('recurring.linkNone')}</span>
          </button>
          {activeRecs.map((rec) => (
            <button
              key={rec.id}
              data-testid={`tx-part-rec-${rec.id}`}
              onClick={() => {
                patchPart({ recurringId: rec.id });
                setRecOpen(false);
              }}
              className="m-tap flex w-full items-center gap-3 border-b border-line-2 px-1 py-3 text-left text-[14px] text-ink"
            >
              <RecurringVisual rec={rec} size={18} />
              <span className="min-w-0 flex-1 truncate">{rec.name}</span>
              {part.recurringId === rec.id && <Icon name="check" size={17} color="var(--m-accent-deep)" />}
            </button>
          ))}
          <button
            data-testid="tx-part-rec-create"
            onClick={() => {
              setRecCreating(true);
              setRecOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={18} />
            {t('recurring.add')}
          </button>
        </div>
      </Sheet>
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
          <EventPickList
            events={activeEvents}
            selectedId={part.eventId}
            testIdPrefix="tx-part-event-"
            onPick={(id) => {
              patchPart({ eventId: id });
              setEventOpen(false);
            }}
          />
          <button
            data-testid="tx-part-event-create"
            onClick={() => {
              setEventCreating(true);
              setEventOpen(false);
            }}
            className="m-tap flex w-full items-center gap-3 px-1 py-3 text-left text-[14px] font-medium text-accent-deep"
          >
            <Icon name="plus" size={18} />
            {t('events.new')}
          </button>
        </div>
      </Sheet>
      {/* create-and-link: prefilled from the PART, the created id files onto this part alone (#251) */}
      {recCreating && (
        <RecurringFormSheet
          initial={partRecurringPrefill(tx, part)}
          onSaved={(id) => patchPart({ recurringId: id })}
          onClose={() => setRecCreating(false)}
        />
      )}
      {eventCreating && (
        <EventFormSheet initial="new" onSaved={(id) => patchPart({ eventId: id })} onClose={() => setEventCreating(false)} />
      )}
    </>
  );
}

/** counterparty property row (#228), the loans count-it-in offer, and the transfer-pair state underneath */
function DetailAccountBlock({
  tx,
  account,
  linkedAccount,
  spaceAccounts,
  pairState,
  peer,
  peerAccountName,
  loanCountBusy,
  setLoanCountBusy,
  onOpenPeer,
  onUnpair,
  onEditCounter,
  onPickCounterpart,
  readOnly,
}: Readonly<{
  tx: SpaceTx;
  account: AccountRow | undefined;
  linkedAccount: AccountRow | undefined;
  /** #505: the space is read-only to this identity — the block's own writes stay hidden */
  readOnly?: boolean;
  /** the accounts as the space names them: the counterparty row speaks that name (#239) */
  spaceAccounts: readonly { id: string; name: string }[] | undefined;
  pairState: ReturnType<typeof transferPairState>;
  /** the other leg as the space sees it, already recut to the exact leg when that leg is a part (#237, #255) */
  peer: SpaceTx | undefined;
  peerAccountName: string | undefined;
  loanCountBusy: boolean;
  setLoanCountBusy: (busy: boolean) => void;
  /** absent when the pair pointer resolves to nothing visible: no dead jump (#255) */
  onOpenPeer?: () => void;
  onUnpair?: () => void;
  /** absent = read-only here (containers and adjustments hide it) */
  onEditCounter?: () => void;
  onPickCounterpart?: () => void;
}>) {
  const { t, lang } = useLang();
  const { store, repo } = useData();
  const counterRow = !!linkedAccount || !!onEditCounter;
  const loanCount = readOnly ? null : loanCountOffer(tx, account, linkedAccount, peer);
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex items-center gap-3 px-4 py-3.5 text-[15px] text-ink" data-testid="tx-detail-account-row">
        <Icon name="bank-outline" size={20} color="var(--m-ink-3)" />
        <span className="min-w-0 flex-1 truncate">{account?.name ?? '—'}</span>
        <span className="text-xs text-ink-4">{t('txform.account')}</span>
      </div>
      {/* sibling buttons, never nested (S6819) */}
      {counterRow && (
        <>
          <div className="mx-4 h-px bg-line-2" />
          <div className="flex w-full items-center gap-3 px-4 py-3 text-[15px] text-ink">
            <Icon name="bank-transfer" size={20} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1">
              <button
                data-testid="tx-detail-counter-row"
                onClick={onEditCounter}
                disabled={!onEditCounter}
                className="m-tap block w-full border-none bg-transparent p-0 text-left"
              >
                <span className={`block truncate ${linkedAccount ? '' : 'text-ink-4'}`} data-testid="tx-detail-linked-account">
                  {linkedAccount ? counterAccountFace(linkedAccount, spaceAccounts).name : t('tx.counterNone')}
                </span>
                {/* a renamed card read as its masked number here while the sheet called it by its name */}
                {linkedAccount && counterAccountFace(linkedAccount, spaceAccounts).number && (
                  <span className="block truncate font-mono text-[11px] text-ink-4" data-testid="tx-detail-linked-number">
                    {counterAccountFace(linkedAccount, spaceAccounts).number}
                  </span>
                )}
                {linkedAccount && ['loan', 'mortgage'].includes(linkedAccount.type) && (
                  <span className="block truncate text-[11px] text-accent-deep" data-testid="tx-detail-pays-debt">
                    {t('tx.paysDebt', { name: linkedAccount.name })}
                  </span>
                )}
              </button>
              {/* dated before the loan's known-true balance, so it did NOT move the balance: the person may count it in once */}
              {loanCount && (
                <button
                  data-testid="tx-detail-loan-count"
                  disabled={loanCountBusy}
                  onClick={() => {
                    // one-shot with a busy latch: the liveQuery re-emit that hides this button trails the write;
                    // a double-tap applied the delta twice
                    setLoanCountBusy(true);
                    void countPreAnchorTx(store, repo, { ...loanCount.source, linkedAccountId: loanCount.loan.id } as never, () =>
                      writeTxTransform(repo, loanCount.source, { loanCounted: 1 }),
                    ).finally(() => setLoanCountBusy(false));
                  }}
                  className="m-tap mt-0.5 block border-none bg-transparent p-0 text-left text-[11px] text-warning underline disabled:opacity-50"
                >
                  {t('tx.loanNotCounted')}
                </button>
              )}
            </span>
            <span className="text-xs text-ink-4">{t('tx.counterAccount')}</span>
            {onEditCounter && <Icon name="chevron-right" size={16} color="var(--m-ink-4)" />}
          </div>
        </>
      )}
      {pairState === 'peered' && (
        <TransferPeerRow t={t} lang={lang} peer={peer} accountName={peerAccountName} onOpen={onOpenPeer} onUnpair={onUnpair} />
      )}
      {pairState === 'awaiting' && (
        <div className="px-4 pb-3">
          <Pill testId="tx-detail-awaiting">{t('tx.awaitingCounterpart')}</Pill>
          {/* the wallet's other side may never arrive from the feed: point at the row already there (#237) */}
          {onPickCounterpart && (
            <button
              data-testid="tx-detail-pick-counter"
              onClick={onPickCounterpart}
              className="m-tap mt-1 block w-full border-none bg-transparent p-0 text-left text-[13px] font-medium text-accent-deep"
            >
              {t('tx.pickCounterpart', { name: linkedAccount?.name ?? '' })}
            </button>
          )}
        </div>
      )}
      {pairState === 'offerCreate' && !readOnly && (
        <div className="px-4 pb-3">
          <button
            data-testid="tx-detail-create-counter"
            onClick={() => void healMissingMirror(store, repo, tx).catch(() => undefined)}
            className="m-tap block w-full border-none bg-transparent p-0 text-left text-[13px] font-medium text-accent-deep"
          >
            {t('tx.createCounterpart', { name: linkedAccount?.name ?? '' })}
          </button>
          {onPickCounterpart && (
            <button
              data-testid="tx-detail-pick-counter"
              onClick={onPickCounterpart}
              className="m-tap mt-1 block w-full border-none bg-transparent p-0 text-left text-[13px] font-medium text-accent-deep"
            >
              {t('tx.pickCounterpart', { name: linkedAccount?.name ?? '' })}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** opens another transaction (or one of its parts) under the tree this detail lives in */
export type OpenTx = (txId: string, part?: string) => void;

// NOSONAR-next-line: S3776 — router-level composition. Every decision
// lives in the module helpers above; only state wiring and JSX visibility gating remain here
// `backTo` is where leaving the detail lands (pane close, Esc, delete): /recurring/tx/$txId passes /recurring
// so the recurring list keeps the master pane (#168)
export function TxDetailScreen({ backTo = '/transactions', openTx }: Readonly<{ backTo?: string; openTx?: OpenTx }> = {}) { // NOSONAR(S3776)
  const { t, lang } = useLang();
  const { store, repo, spaceId } = useData();
  // #505 (user): a space this identity only reads shows the transaction, never an edit door
  const canEdit = useCanEdit();
  const readOnlyRegion = canEdit ? undefined : true;
  const { txId } = useParams({ strict: false }) as { txId: string };
  const [editOpen, setEditOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [titleBulk, setTitleBulk] = useState<{ title: string } | null>(null);
  const [titleSelected, setTitleSelected] = useState<ReadonlySet<string>>(new Set());
  // counterPickOpen is the property row's picker; counterOpen is the read-only account INFO sheet (#228)
  const [counterPickOpen, setCounterPickOpen] = useState(false);
  // declared with the other hooks: the `!tx` return below must never reorder them
  const [unpairConfirm, setUnpairConfirm] = useState<null | 'mint' | 'default'>(null);
  const [matchOpen, setMatchOpen] = useState(false);
  const [loanCountBusy, setLoanCountBusy] = useState(false);
  const [splitOpen, setSplitOpen] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  // splitting from the detail writes NOTHING until every part is complete, then lands in ONE write (#126)
  const [splitStage, setSplitStage] = useState<TxSplit[] | null>(null);
  const [completeOpen, setCompleteOpen] = useState(false);
  const [applyAttention, setApplyAttention] = useState(false);
  const [splitResetOpen, setSplitResetOpen] = useState(false);
  const { part: partParam } = useSearch({ strict: false }) as { part?: string };
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [recCreating, setRecCreating] = useState(false);
  const [eventCreating, setEventCreating] = useState(false);
  const [eventOpen, setEventOpen] = useState(false);
  const [counterOpen, setCounterOpen] = useState(false);
  const [bulkOffer, setBulkOffer] = useState<BulkOfferState | null>(null);
  const [counterBulk, setCounterBulk] = useState<{ items: SpaceTx[]; catId: string; accountId: string } | null>(null);
  // #495 (user): the bulk siblings' receipts walk in turn afterwards — after the counter queue, over the ones it settled
  const [receiptBulk, setReceiptBulk] = useState<SpaceTx[] | null>(null);
  const pendingReceiptBulk = useRef<SpaceTx[] | null>(null);
  const counterSettled = useRef(new Set<string>());
  const receiptInventory = useAttachableReceipts();
  const receiptProposals = useProposedMatches();
  // mutually exclusive with the category offer: they share the bar (#141)
  const [splitBulk, setSplitBulk] = useState<TxSplit[] | null>(null);
  const [splitSelected, setSplitSelected] = useState<ReadonlySet<string>>(new Set());
  const [catsBulk, setCatsBulk] = useState<TxSplitCat[] | null>(null);
  const [catsSelected, setCatsSelected] = useState<ReadonlySet<string>>(new Set());
  // a settlement AFTER arming rewrites the category attribution, so the stale offer must retire
  const bulkArmedReimbRef = useRef(0);
  const [bulkSelected, setBulkSelected] = useState<ReadonlySet<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  // #674: an offer belongs to the transaction it was made on; beside the list this screen stays mounted while another
  // row opens, and the offer stood on the next one
  useEffect(() => {
    setTitleBulk(null);
    setBulkOffer(null);
    setSplitBulk(null);
    setCatsBulk(null);
  }, [txId]);
  const navigate = useNavigate();
  // a detour to another transaction stays under the tree this detail was opened in; the default is /transactions
  const open: OpenTx = openTx ?? ((txId, part) => void navigate({ to: '/transactions/$txId', params: { txId }, search: part ? { part } : {} }));
  const panes = useLgViewport();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // any open sheet owns Esc, mobile sheets included (they render no <dialog>)
      if (e.key !== 'Escape' || hasOpenSheet() || document.querySelector('dialog[open], [role="dialog"]')) return;
      void navigate({ to: backTo });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, backTo]);

  const tx = useSpaceTransaction(txId);
  const transform = useTxTransform();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  // #545: the names this space gave its accounts, never the global ones
  const account = useSpaceAccount(tx?.accountId);
  const linkedAccount = useSpaceAccount(tx?.linkedAccountId);
  const spaceAccounts = useSpaceAccounts();
  // read-time join: once an account with this IBAN exists locally, the counterparty upgrades from plain text to a live door
  const counterIban = normalizedCounterIban(tx);
  const counterAccount = useQuery(
    store,
    async () =>
      counterIban
        ? asSpaceAccount(
            store,
            spaceId,
            (await store.allRows('account')).find((a) => a.deleted === 0 && !!a.iban && normalizeIban(a.iban) === counterIban),
          )
        : undefined,
    [counterIban, spaceId],
  );
  const cats = useCategories();
  const recurrings = useRecurrings();
  const recurringOps = useRecurringOps();
  const events = useEvents();
  // the expenses own the reimbursement links, so a credit's net worth is derived
  const allTxs = useSpaceTransactions();
  const givenOut = givenOutFor(tx, allTxs);

  // pairs can exist ONE-WAY in stored data (the reciprocal write used to land on the raw feed row): read the pair from
  // either direction: the row's own peer, a row pointing here, or a split PART pointing here (#237)
  const reversePeer = useMemo(
    () =>
      tx && !tx.transferPeerId
        ? allTxs?.find(
            (row) =>
              row.id !== tx.id &&
              row.deleted === 0 &&
              (row.transferPeerId === tx.id || !!row.splits?.some((s) => s.transferPeerId === tx.id)),
          )
        : undefined,
    [tx, allTxs],
  );
  const effectivePeerId = tx?.transferPeerId ?? reversePeer?.id;
  const resolvedPeer = useMemo(
    () => (tx ? resolvePairPeer(tx.id, effectivePeerId, allTxs) : null),
    [tx, effectivePeerId, allTxs],
  );
  const peerAccount = useSpaceAccount(resolvedPeer?.row.accountId);
  // heals the missing reciprocal once per pairing; the key latch keeps the heal from re-arming a pair mid-unpair
  const healedPairRef = useRef<string | null>(null);
  useEffect(() => {
    if (!tx || !allTxs) return;
    const key = `${tx.id}:${tx.transferPeerId ?? ''}:${reversePeer?.id ?? ''}`;
    if (healedPairRef.current === key) return;
    healedPairRef.current = key;
    const upkeep = repo.upkeep(); // #505: a heal, not the person's edit — skipped where they only read
    if (tx.transferPeerId) {
      const peer = allTxs.find((row) => row.id === tx.transferPeerId && row.deleted === 0);
      if (peer && !peer.transferPeerId && !peer.splits?.some((s) => s.transferPeerId === tx.id)) {
        void writeTxTransform(upkeep, peer, { transferPeerId: tx.id });
      }
    } else if (reversePeer?.transferPeerId === tx.id && !tx.splits?.some((s) => s.transferPeerId === reversePeer.id)) {
      // row-level pointer only: a part-level pick's reciprocal ALSO points at the container, and lifting it minted a
      // duplicate row-level pair on top of the part's own (#255)
      void writeTxTransform(upkeep, tx, { transferPeerId: reversePeer.id });
    }
  }, [tx, allTxs, reversePeer, repo]);

  // a settlement after the bulk offer armed makes its premise stale: retire it
  const reimbNow = tx ? totalReimbursedCents(tx) + givenOut : 0;
  useEffect(() => {
    if (bulkOffer && reimbNow !== bulkArmedReimbRef.current) setBulkOffer(null);
  }, [reimbNow, bulkOffer]);

  // display-currency lens: the headline converts at THIS day's fixing
  const { fmt, ensureDates, fmtSensitive } = useDisplayMoney();
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
  const ownStamp = accountStamp(account?.type);
  const pairState = transferPairState(tx, effectivePeerId, linkedAccount);
  // the peer is fetched from the STORE when the live snapshot hasn't emitted it (CI-only flake)
  // unpairing releases both legs; a reverse-only pair releases from this side by clearing the pointing side (#237)
  const releasePair = () => {
    if (tx.transferPeerId) {
      void releasePeerLeg(store, repo, spaceId, tx, allTxs);
      void transform(tx, { transferPeerId: null as never }, 'txLink');
      return;
    }
    if (!reversePeer) return;
    if (reversePeer.transferPeerId === tx.id) {
      void writeTxTransform(repo, reversePeer, { transferPeerId: null as never });
    } else if (reversePeer.splits?.some((s) => s.transferPeerId === tx.id)) {
      void writeTxTransform(repo, reversePeer, {
        splits: reversePeer.splits.map((s) => (s.transferPeerId === tx.id ? { ...s, transferPeerId: undefined } : s)),
      });
    }
  };
  // unlinking asks first when something is at stake: the cash wallet (#546) resets the whole story, munni's own generated leg
  // can be removed or kept; a picked/bank pair just releases (#237)
  const unpair = () => {
    // the deterministic id decides, not the async account row: a tap racing the query must not route the wallet wrongly
    if (tx.linkedAccountId === cashWalletId(tx.spaceId)) setUnpairConfirm('default');
    else if (tx.transferPeerId === mirrorTxId(tx.id)) setUnpairConfirm('mint');
    else releasePair();
  };
  // the question decides the GENERATED row's fate; the source keeps its counterparty either way (#237)
  // Keep: the leg becomes an ordinary row, its balance effect stays; Remove: it tombstones and its balance refunds
  const keepGeneratedLeg = async () => {
    const mirror = await store.get('transaction', tx.transferPeerId!);
    if (mirror?.deleted === 0) {
      await writeTxTransform(repo, mirror, { linkedAccountId: null as never, transferPeerId: null as never });
    }
    await transform(tx, { transferPeerId: null as never }, 'txLink');
  };
  const removeGeneratedLeg = async () => {
    await removeMirrorForDeletedSource(store, repo, tx, tx.linkedAccountId);
    await transform(tx, { transferPeerId: null as never }, 'txLink');
  };
  const pairWithPicked = async (pickedTxId: string) => {
    await transform(tx, { transferPeerId: pickedTxId }, 'txLink');
    await pairWithExistingRow(store, repo, spaceId, tx, pickedTxId, allTxs);
    // a standing bulk offer upgrades: the anchor now points at a SPECIFIC row,
    // so applying must queue per-sibling counter picks (#268)
    setBulkOffer((offer) =>
      offer?.link && offer.link.accountId === tx.linkedAccountId ? { ...offer, link: { ...offer.link, viaPeer: true } } : offer,
    );
  };
  // a credit that self-filed as Reimbursed keeps it while any link lives; the part a PARTIAL link left open is the person's
  // to file: the settled slice stays pinned inside the editor, the remainder is editable
  const openRemainder = (tx.cats ?? []).some((c) => c.catId !== REIMBURSED_ID && c.amountCents !== 0);
  const categoryLocked = tx.catId === REIMBURSED_ID && givenOut > 0 && !openRemainder;
  // the recurring OWNS the category: a linked row only picks between the recurring's category and expected reimbursement
  const recurringAllowedCats = recurringCatConstraint(tx, recurrings);

  const parts = tx.splits ?? [];
  const multiPart = parts.length > 1;
  // pickers list archived events too, labelled, after the active ones (#537)
  const activeEventsList = events ?? [];
  const activeRecsList = (recurrings ?? []).filter((r) => r.active === 1);
  const stageComplete = stagedSplitComplete(splitStage);
  const unsplitFallbackCat = primaryCatId(parts) ?? tx.catId ?? UNCATEGORIZED_ID;
  const openValuesEditor = () => setSplitOpen(true);
  // splitting RESETS the transaction's own story: a filled row gets a warning before the split flow opens
  const requestSplit = () => {
    const hasStory =
      !!tx.notes || !!tx.eventId || !!tx.recurringId || !!tx.cats?.length ||
      (!!tx.catId && tx.catId !== UNCATEGORIZED_ID);
    if (hasStory) setSplitResetOpen(true);
    else openValuesEditor();
  };
  // the categories pencil opens the split-categories editor on a whole row; a container routes into the manage flow (#211)
  const openCategoriesEditor = multiPart ? openValuesEditor : () => setCatsOpen(true);
  const splitDoorMode = splitDoorModeFor(multiPart, categoryLocked);
  const applyStagedSplit = () => {
    if (!splitStage) return;
    if (!stageComplete) {
      setApplyAttention(true);
      return;
    }
    // the stage lands in ONE write; the container's own story resets with explicit nulls: an undefined drops from the op
    // and leaves stale values behind (LWW)
    void transform(tx, {
      splits: splitStage,
      catId: primaryCatId(splitStage) ?? tx.catId,
      // a container owns no category spread: the explicit null also VERSION-STAMPS the row,
      // so fresh devices read the splits as real parts (#211)
      cats: null as never,
      // #260: landing a split IS the review decision for this row
      needsReview: 0,
      ...(tx.notes ? { notes: '' } : {}),
      ...(tx.eventId ? { eventId: null as never } : {}),
      ...(tx.recurringId ? { recurringId: null as never } : {}),
    });
    armSplitBulk(splitStage);
    setApplyAttention(false);
    setSplitStage(null);
    setCompleteOpen(false);
  };
  const partsSettledCents = parts.reduce((sum, part) => sum + reimbursedInCats(part.cats), 0);
  const unsplitTo = (catId: string) => {
    setSplitStage(null);
    // removing the split retires the armed bulk offers: a bar selling the deleted partition is stale (#201)
    setSplitBulk(null);
    setCatsBulk(null);
    setBulkOffer(null);
    writeUnsplit(transform, tx, unsplitFallbackCat, partsSettledCents, catId);
  };

  const settledPartitionCents = (tx.cats ?? []).filter((e) => e.catId === REIMBURSED_ID).reduce((sum, e) => sum + e.amountCents, 0);
  const singleCatFields = (catId: string) => singleCatPartitionFields(tx, multiPart, settledPartitionCents, catId);

  const applySingleEntry = (entry: CatsApplyEntry) =>
    void writeRowSingleEntry(
      {
        tx, cats, store, repo, spaceId, transform, allTxs, reimbNow, bulkArmedReimbRef, singleCatFields,
        setSplitBulk, setCatsBulk, setBulkOffer, setBulkSelected,
      },
      entry,
    );

  // the account's KIND names the category (bijection re-pick rule: doors overwrite deliberately);
  // a stamped row forces its movement sub (#228)
  const applyCounterPick = (picked: { id: string; type: AccountRow['type'] }, peer?: { txId: string }) =>
    applySingleEntry({
      catId: (ownStamp ? stampMovementSub(ownStamp, tx.amountCents) : undefined) ?? movementCatFor(picked.type, tx.amountCents),
      amountCents: Math.abs(tx.amountCents),
      linkedAccountId: picked.id,
      ...(peer ? { transferPeerId: peer.txId } : {}),
    });
  // removing the counterparty RESETS the category: the movement story and its account are one fact (#228)
  const removeCounter = () =>
    applySingleEntry({ catId: UNCATEGORIZED_ID, amountCents: Math.abs(tx.amountCents) });

  const armSplitBulk = (stored: TxSplit[]) => {
    const similar = splitBulkTargets(allTxs, tx, stored);
    setBulkOffer(null);
    setCatsBulk(null);
    setSplitBulk(similar.length > 0 ? stored : null);
    setSplitSelected(new Set(similar.map((item) => item.id)));
  };
  const splitTargets = splitBulk ? splitBulkTargets(allTxs, tx, splitBulk) : [];
  const applySplitBulk = async () => {
    if (!splitBulk) return;
    const picked = splitTargets.filter((target) => splitSelected.has(target.id));
    const n = await writeSplitBulk(transform, () => repo.newId(), splitBulk, picked);
    if (n > 0) void logActivity(store, repo, spaceId, 'txCategory', `${txTitle(tx)} +${n}`);
    setSplitBulk(null);
  };

  const armCatsBulk = (entries: TxSplitCat[]) => {
    const similar = catsBulkTargets(allTxs, tx, entries);
    setBulkOffer(null);
    setSplitBulk(null);
    setCatsBulk(similar.length > 0 ? entries : null);
    setCatsSelected(new Set(similar.map((item) => item.id)));
  };
  const catsTargets = catsBulk ? catsBulkTargets(allTxs, tx, catsBulk) : [];
  const applyCatsBulk = async () => {
    if (!catsBulk) return;
    const picked = catsTargets.filter((target) => catsSelected.has(target.id));
    // the siblings whose receipt wants a look: read before the writes settle their review (#495)
    const walk = receiptsToVerify(picked, receiptInventory, receiptProposals);
    const n = await writeCatsBulk(transform, catsBulk, picked);
    if (n > 0) void logActivity(store, repo, spaceId, 'txCategory', `${txTitle(tx)} +${n}`);
    setCatsBulk(null);
    if (walk.length > 0) setReceiptBulk(walk);
  };

  const bulkTargets = catBulkTargets(allTxs, tx, bulkOffer);

  /** rename: '' clears the override (LWW needs the explicit value) */
  const renameTitle = (raw: string) => {
    const title = raw.trim();
    const next = title && title !== cleanBankText(tx.merchant) ? title : '';
    void transform(tx, { titleOverride: next });
    // #674: a row that reads the new title already has nothing to take over
    const similar = similarTo(allTxs, tx, (item) => txTitle(item) !== next);
    setTitleBulk(next && similar.length > 0 ? { title: next } : null);
    setTitleSelected(new Set(similar.map((item) => item.id)));
  };

  const titleTargets = titleBulkTargets(allTxs, tx, titleBulk);

  const applyTitleBulk = async () => {
    if (!titleBulk) return;
    const picked = titleTargets.filter((target) => titleSelected.has(target.id));
    for (const item of picked) await transform(item, { titleOverride: titleBulk.title }, null);
    if (picked.length) void logActivity(store, repo, spaceId, 'txEdit', `${txTitle(tx)} +${picked.length}`);
    setTitleBulk(null);
  };

  const applyBulk = async () => {
    if (!bulkOffer) return;
    const picked = bulkTargets.filter((target) => bulkSelected.has(target.id));
    // the siblings whose receipt wants a look: read before the writes settle their review (#495)
    const walk = receiptsToVerify(picked, receiptInventory, receiptProposals);
    // a SPECIFIC counter pick cannot be copied: each sibling asks for its own counter row (#268)
    if (bulkOffer.link?.viaPeer && picked.length > 0) {
      counterSettled.current = new Set();
      pendingReceiptBulk.current = walk.length > 0 ? walk : null;
      setCounterBulk({ items: picked, catId: bulkOffer.catId, accountId: bulkOffer.link.accountId });
      setBulkOffer(null);
      return;
    }
    // one history line for the whole bulk; a plain account link rides along, each sibling links and waits (#268)
    for (const item of picked) {
      await transform(
        item,
        {
          catId: bulkOffer.catId,
          needsReview: 0,
          ...(bulkOffer.link ? { linkedAccountId: bulkOffer.link.accountId } : {}),
        },
        null,
      );
    }
    if (picked.length) void logActivity(store, repo, spaceId, 'txCategory', `${txTitle(tx)} +${picked.length}`);
    setBulkOffer(null);
    if (walk.length > 0) setReceiptBulk(walk);
  };

  const resolveCounterBulk = async (item: SpaceTx, peerId: string | null) => {
    if (!counterBulk) return;
    if (item.transferPeerId) void releasePeerLeg(store, repo, spaceId, item, allTxs);
    await transform(
      item,
      {
        catId: counterBulk.catId,
        needsReview: 0,
        linkedAccountId: counterBulk.accountId as never,
        ...(peerId ? { transferPeerId: peerId } : {}),
      },
      null,
    );
    if (peerId) await pairWithExistingRow(store, repo, spaceId, item, peerId, allTxs);
    counterSettled.current.add(item.id);
  };
  const saveNotes = (notes: string) => {
    if (notes === (tx.notes ?? '')) return;
    void transform(tx, { notes }, null); // 'note' is the richer line
    void logActivity(store, repo, spaceId, 'note', txTitle(tx));
  };

  const deleteManualTx = async () => {
    await deleteManualTxRow(store, repo, spaceId, tx, account);
    void navigate({ to: backTo });
  };

  const fmtDay = new Intl.DateTimeFormat(DATE_FMT[lang], { weekday: 'long', day: 'numeric', month: 'long' });

  const partView = findPartView(parts, partParam);
  const partDefault = derivedPartLabel(tx, parts, partView, t);
  const savePartLabel = (raw: string): void => writePartLabel(transform, tx, partView, partDefault, raw);
  const renameProps = renameSheetProps(tx, partView, partDefault, savePartLabel, renameTitle);
  const screenTitle = detailScreenTitle(tx, parts, partView, t);
  // #567: an ordinary payment whose categories are the person's to edit can be filed by its receipt's lines;
  // the offer to repeat a spread stays out: similar payments have other receipts
  const byReceipt =
    canEdit && !partView && !multiPart && !categoryLocked && tx.amountCents < 0 && tx.txType === 'expense'
      ? (entries: TxSplitCat[]) =>
          applyRowCats({ tx, settledCents: settledPartitionCents, transform, applySingle: applySingleEntry, armCatsBulk: () => undefined }, entries)
      : undefined;
  const trailingAction = canEdit ? detailTrailingAction(!!partView, tx.importRef, t, () => setRenameOpen(true), () => setEditOpen(true)) : null;
  const editorValue = valuesEditorValue(splitStage, multiPart, parts);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-tx-detail">
      <AppBar
        title={<SearchableTitle text={screenTitle} query={txTitle(tx)} testId="tx-detail-search-web" titleTestId="tx-detail-title" />}
        wrapTitle
        leading={
          <DetailBackButton panes={panes} onClose={() => void navigate({ to: backTo, replace: true })} t={t} />
        }
        trailing={trailingAction}
      />
      {!tx.importRef && <TxFormSheet open={editOpen} onOpenChange={setEditOpen} tx={tx} />}
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <ReadOnlyNote className="mt-3" testId="tx-detail-readonly-note" />
        {partView ? (
          <div inert={readOnlyRegion}>
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
            open={open}
          />
          </div>
        ) : (
          <>
        <div className="flex flex-col items-center py-6 text-center">
          {/* both directions show the net truth: expenses minus what came back, credits minus what they refunded elsewhere */}
          <div className="m-num text-4xl text-ink" data-testid="tx-detail-amount">
            {headlineAmount}
          </div>
          <div className="mt-1 text-sm text-ink-3">
            {fmtDay.format(new Date(tx.date))}
            {tx.time ? ` · ${tx.time}` : ''}
          </div>
          {/* the recorded truth stays one line below the converted headline: a detail screen must never hide it */}
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

        <DetailAccountBlock
          tx={tx}
          account={account}
          linkedAccount={linkedAccount}
          spaceAccounts={spaceAccounts}
          pairState={pairState}
          peer={resolvedPeer ? pairPeerFace(resolvedPeer, t) : undefined}
          peerAccountName={peerAccount?.deleted === 0 ? peerAccount.name : undefined}
          loanCountBusy={loanCountBusy}
          setLoanCountBusy={setLoanCountBusy}
          // the tap lands on the RESOLVED leg (peer row or exact part page); unresolvable = no jump:
          // a blind jump rendered an empty detail (#255)
          onOpenPeer={
            resolvedPeer ? () => open(resolvedPeer.nav.txId, resolvedPeer.nav.part ?? undefined) : undefined
          }
          onUnpair={canEdit ? unpair : undefined}
          // a recurring-narrowed row's counter door STAYS open: a fully inert row left funding picks unescapable;
          // the sheet's detach is the way out (it resets the category too) (#265)
          onEditCounter={
            !canEdit || multiPart || tx.adjustment === 1 || tx.txType === 'adjustment'
              ? undefined
              : () => setCounterPickOpen(true)
          }
          onPickCounterpart={canEdit ? () => setMatchOpen(true) : undefined}
          readOnly={!canEdit}
        />

        {!partView && <EntryLinkSection tx={tx} account={account} readOnly={!canEdit} />}

        {/* #538: said to everyone in the space, so nobody adds the payment twice */}
        {!partView && tx.splitRef && (
          <button
            data-testid="tx-detail-split"
            onClick={() => void navigate({ to: '/splits/$splitId', params: { splitId: tx.splitRef?.splitId ?? '' } })}
            className="m-tap mt-3 flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left text-[13px] text-ink-2"
          >
            <Icon name="account-cash-outline" size={18} color="var(--m-accent-deep)" />
            <span className="min-w-0 flex-1 truncate">{t('tx.inSplit', { name: tx.splitRef.name })}</span>
            <Icon name="chevron-right" size={18} color="var(--m-ink-4)" />
          </button>
        )}

        {/* one edit affordance for the block (a pencil per slice read wrong); on a container the block lists PARTS */}
        <CategoriesHeader
          locked={categoryLocked}
          byRecurring={!!recurringAllowedCats}
          multiPart={multiPart}
          onEdit={canEdit ? openCategoriesEditor : undefined}
        />
        <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="tx-detail-categories">
          <CategorySlices
            tx={tx}
            cats={cats}
            fallbackCat={cat}
            fallbackColor={color}
            onEdit={categoryLocked || !canEdit ? undefined : openCategoriesEditor}
            onOpenPart={(id) => open(tx.id, id)}
          />
          {bulkOffer && (
            <DetailBulkBar
              targets={bulkTargets}
              selected={bulkSelected}
              onChange={setBulkSelected}
              onApply={() => void applyBulk()}
              onDismiss={() => setBulkOffer(null)}
            />
          )}
          {!bulkOffer && splitBulk && (
            <DetailBulkBar
              targets={splitTargets}
              selected={splitSelected}
              onChange={setSplitSelected}
              onApply={() => void applySplitBulk()}
              onDismiss={() => setSplitBulk(null)}
            />
          )}
          {!bulkOffer && !splitBulk && catsBulk && (
            <DetailBulkBar
              targets={catsTargets}
              selected={catsSelected}
              onChange={setCatsSelected}
              onApply={() => void applyCatsBulk()}
              onDismiss={() => setCatsBulk(null)}
            />
          )}
        </div>

        {/* a container carries no notes/reimbursements/receipts: the parts do; actions and facts run for every row (#232) */}
        {resolveTxDetailBlocks(space)
          .filter((entry) => !entry.hidden)
          .map((entry) => {
            const attachable = !multiPart;
            const section: Record<TxDetailBlockId, ReactNode> = {
              // the split door leads the actions; recurring + event links follow, non-container rows only: parts own their links (#213)
              actions: (
                <DetailActionsCard
                  tx={tx}
                  multiPart={multiPart}
                  splitDoorMode={splitDoorMode}
                  recurrings={recurrings}
                  events={events}
                  onSplitDoor={splitDoorMode === 'row' ? requestSplit : openValuesEditor}
                  onOpenRecurring={() => setRecurringOpen(true)}
                  onOpenEvent={() => setEventOpen(true)}
                />
              ),
              facts: (
                <DetailFacts
                  tx={tx}
                  givenOut={givenOut}
                  counterAccountName={counterAccount?.name}
                  onOpenCounterAccount={() => setCounterOpen(true)}
                />
              ),
              reimburse: attachable ? <ReimburseSection tx={tx} /> : null,
              receipts: attachable ? <ReceiptSection tx={tx} onCategorise={byReceipt} /> : null,
              notes: attachable ? (
                <>
                  <div className="m-cap mt-5 mb-1 px-1">{t('tx.notes')}</div>
                  <NotesField
                    value={tx.notes ?? ''}
                    onSave={saveNotes}
                    placeholder={t('tx.notesPlaceholder')}
                    className="w-full resize-none rounded-card border border-line bg-surface px-4 py-3 text-[14px] text-ink outline-none placeholder:text-ink-4"
                  />
                </>
              ) : null,
            };
            // #505: every block but the facts edits the row — inert where the space is read-only
            return (
              <div key={entry.id} inert={entry.id === 'facts' ? undefined : readOnlyRegion}>
                {section[entry.id]}
              </div>
            );
          })}

        {canEdit && (
          <button
            data-testid="tx-detail-customize"
            onClick={() => void navigate({ to: '/tx-customize' })}
            className="m-tap mt-5 flex w-full items-center justify-center gap-2 rounded-card border border-dashed border-line bg-transparent py-2.5 text-[13px] font-medium text-ink-3"
          >
            <Icon name="tune-variant" size={16} />
            {t('tx.customize')}
          </button>
        )}

        {/* bank rows are the bank's truth and only ever tombstone via their feed */}
        {canEdit && !tx.importRef && !tx.feedSpaceId && (
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

      {/* no cooldown: one transaction is a low-stakes delete */}
      <DangerConfirmSheet
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t('tx.deleteManual')}
        body={t('tx.deleteManualBody', { name: txTitle(tx) })}
        cooldown={0}
        onConfirm={() => void deleteManualTx()}
        testId="tx-delete"
      />

      <CounterpartySheet
        open={counterPickOpen}
        onOpenChange={setCounterPickOpen}
        excludeAccountId={tx.accountId}
        currentLinkedId={tx.linkedAccountId}
        defaultFamily={!ownStamp && tx.catId && specialCatType(tx.catId) ? (defaultFamilyFor(tx.catId) ?? undefined) : undefined}
        counterTypes={tx.catId && specialCatType(tx.catId) ? counterTypesFor(tx.catId) : undefined}
        anchor={{ id: tx.id, amountCents: tx.amountCents, date: tx.date }}
        onChoose={(picked, peer) => applyCounterPick(picked, peer)}
        onDetach={tx.linkedAccountId ? removeCounter : undefined}
      />
      {/* same-sign wallet rows included (#237) */}
      {linkedAccount && (
        <CounterMatchSheet
          open={matchOpen}
          onOpenChange={setMatchOpen}
          target={{ id: linkedAccount.id, name: counterAccountFace(linkedAccount, spaceAccounts).name }}
          anchor={{ id: tx.id, amountCents: tx.amountCents, date: tx.date, accountId: tx.accountId }}
          rows={allTxs ?? []}
          onPick={(pickedTxId) => void pairWithPicked(pickedTxId)}
        />
      )}
      {counterBulk && (
        <BulkCounterQueue
          queue={counterBulk.items}
          target={{ id: counterBulk.accountId, name: linkedAccount?.id === counterBulk.accountId ? linkedAccount.name : '' }}
          rows={allTxs ?? []}
          onResolve={(item, peerId) => void resolveCounterBulk(item as SpaceTx, peerId)}
          onDone={(resolved) => {
            if (resolved > 0) void logActivity(store, repo, spaceId, 'txCategory', `${txTitle(tx)} +${resolved}`);
            setCounterBulk(null);
            const walk = (pendingReceiptBulk.current ?? []).filter((item) => counterSettled.current.has(item.id));
            pendingReceiptBulk.current = null;
            if (walk.length > 0) setReceiptBulk(walk);
          }}
        />
      )}
      {receiptBulk && <BulkReceiptQueue queue={receiptBulk} onDone={() => setReceiptBulk(null)} />}
      <DangerConfirmSheet
        open={unpairConfirm === 'default'}
        onOpenChange={(next) => {
          if (!next) setUnpairConfirm(null);
        }}
        title={t('tx.unlinkDefaultTitle')}
        body={t('tx.unlinkDefaultBody')}
        confirmLabel={t('tx.unlinkContinue')}
        cooldown={0}
        onConfirm={() => {
          setUnpairConfirm(null);
          removeCounter();
        }}
        testId="tx-unlink-default"
      />
      <Sheet
        open={unpairConfirm === 'mint'}
        onOpenChange={(next) => {
          if (!next) setUnpairConfirm(null);
        }}
        title={t('tx.unpairMintTitle')}
        size="form"
      >
        <div className="flex flex-col gap-3 pt-1" data-testid="tx-unpair-mint">
          <p className="text-[14px] leading-relaxed text-ink-2">
            {t('tx.unpairMintBody', { name: linkedAccount?.name ?? '' })}
          </p>
          <Button
            data-testid="tx-unpair-remove"
            onClick={() => {
              setUnpairConfirm(null);
              void removeGeneratedLeg();
            }}
          >
            {t('tx.unpairRemove')}
          </Button>
          <Button
            variant="ghost"
            data-testid="tx-unpair-keep"
            onClick={() => {
              setUnpairConfirm(null);
              void keepGeneratedLeg();
            }}
          >
            {t('tx.unpairKeep')}
          </Button>
        </div>
      </Sheet>
      <DetailSplitSheets
        tx={tx}
        splitOpen={splitOpen}
        setSplitOpen={setSplitOpen}
        editorValue={editorValue}
        // parts are independent: the whole-row recurring constraint must not narrow them (#289)
        allowedCatIds={undefined}
        unsplitTo={unsplitTo}
        unsplitFallbackCat={unsplitFallbackCat}
        splitStage={splitStage}
        setSplitStage={setSplitStage}
        completeOpen={completeOpen}
        setCompleteOpen={setCompleteOpen}
        activeEvents={activeEventsList}
        lockedKind={!!ownStamp}
        recurrings={activeRecsList}
        attention={applyAttention}
        openValuesEditor={openValuesEditor}
        applyStagedSplit={applyStagedSplit}
      />
      {/* one entry = a plain pick (bulk offer intact); several = one spread write; settled `reimbursed` is re-attached (#211) */}
      <CatsSheet
        open={catsOpen}
        onOpenChange={setCatsOpen}
        subject={{
          id: tx.id,
          label: txTitle(tx),
          catId: tx.catId,
          // the FULL partition rides in: the sheet pins the settled bookkeeping read-only and nets the gross itself (#228)
          cats: tx.cats?.length ? tx.cats : undefined,
          amountCents: Math.abs(tx.amountCents),
          linkedAccountId: tx.linkedAccountId,
          transferPeerId: tx.transferPeerId,
        }}
        currency={tx.currency}
        direction={tx.amountCents < 0 ? 'debit' : 'credit'}
        txType={tx.txType}
        allowedCatIds={recurringAllowedCats}
        title={t('split.catsTitle')}
        includePct
        excludeAccountId={tx.accountId}
        askDisabled={!!ownStamp}
        anchor={{ id: tx.id, date: tx.date }}
        onApply={(entries) =>
          applyRowCats({ tx, settledCents: settledPartitionCents, transform, applySingle: applySingleEntry, armCatsBulk }, entries)
        }
      />
      <Sheet open={splitResetOpen} onOpenChange={setSplitResetOpen} title={t('split.resetWarnTitle')} size="compact">
        <div className="flex flex-col gap-3 pt-1">
          <p className="text-[13px] leading-relaxed text-ink-2">{t('split.resetWarnBody')}</p>
          <Button
            data-testid="split-reset-continue"
            onClick={() => {
              setSplitResetOpen(false);
              openValuesEditor();
            }}
          >
            {t('split.resetContinue')}
          </Button>
          <Button variant="outline" data-testid="split-reset-cancel" onClick={() => setSplitResetOpen(false)}>
            {t('action.cancel')}
          </Button>
        </div>
      </Sheet>
      <RenameTitleSheet open={renameOpen} onOpenChange={setRenameOpen} {...renameProps} />

      <Sheet open={counterOpen && !!counterAccount} onOpenChange={setCounterOpen} title={counterAccount?.name ?? ''} size="compact">
        {counterAccount && (
          <div className="flex flex-col pt-1" data-testid="counterparty-sheet">
            <div className="flex items-center justify-between border-b border-line-2 px-1 py-3 text-[14px]">
              <span className="text-ink-3">{t('tx.counterparty')}</span>
              <span className="font-mono text-[13px] text-ink">{counterAccount.iban}</span>
            </div>
            <div className="flex items-center justify-between border-b border-line-2 px-1 py-3 text-[14px]">
              <span className="text-ink-3">{t('acct.balanceNow')}</span>
              <span className="m-num text-ink">{fmtSensitive(counterAccount.balanceCents, counterAccount.currency, { asRecorded: true })}</span>
            </div>
            <div className="flex items-center justify-between px-1 py-3 text-[14px]">
              <span className="text-ink-3">{t('tx.counterpartySource')}</span>
              <span className="text-ink">{t(counterAccount.source === 'manual' ? 'acct.manual' : 'acct.automated')}</span>
            </div>
          </div>
        )}
      </Sheet>

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
          <EventPickList
            events={events ?? []}
            selectedId={tx.eventId}
            testIdPrefix="tx-event-"
            onPick={(id) => {
              void transform(tx, { eventId: id }, 'txLink');
              setEventOpen(false);
            }}
          />

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
      {eventCreating && (
        <EventFormSheet
          initial="new"
          onSaved={(id) => void transform(tx, { eventId: id }, 'txLink')}
          onClose={() => setEventCreating(false)}
        />
      )}

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

/** remote edits replace the draft whenever this user is not typing in the field (shared spaces) */
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

function recurringCatConstraint(
  tx: { recurringId?: string },
  recurrings: { id: string; catId?: string }[] | undefined,
): string[] | undefined {
  const rec = tx.recurringId ? recurrings?.find((r) => r.id === tx.recurringId) : undefined;
  return rec?.catId ? [rec.catId, EXPECTED_REIMBURSE_ID] : undefined;
}

// on a split container the rows are PARTS, so the caption says "Split transactions";
// a lock shows while a reimbursement owns the attribution
function CategoriesHeader({
  locked,
  byRecurring,
  multiPart,
  onEdit,
}: Readonly<{ locked: boolean; byRecurring?: boolean; multiPart?: boolean; onEdit?: () => void }>) {
  const { t } = useLang();
  return (
    <div className="m-cap mt-5 mb-1 flex items-center justify-between px-1">
      <span>
        {t(multiPart ? 'split.partsSection' : 'screen.categories')}
        {/* not a hard lock: Edit still opens the editor, whose picker offers only the recurring's category + expected reimb. */}
        {byRecurring && !locked && (
          <span className="pl-2 font-normal text-ink-4" data-testid="tx-detail-cats-recurring">
            {t('tx.setByRecurring')}
          </span>
        )}
      </span>
      {locked && (
        <span className="flex items-center gap-1 text-[11px] text-ink-4" data-testid="tx-detail-cats-locked">
          <Icon name="lock-outline" size={12} />
          {t('reimb.categoryLocked')}
        </span>
      )}
      {/* on a container the pencil is gone: Manage splits is the one door; absent onEdit = read-only space (#200, #505) */}
      {!locked && !multiPart && onEdit && (
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

