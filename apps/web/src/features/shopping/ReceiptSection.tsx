import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useCanEdit } from '@/app/useCanEdit';
import { useQuery } from '@/db/useQuery';
import { useReceiptFile } from '@/application/receiptFiles';
import { useReceiptOps } from '@/application/receipts';
import { useItemMemory, useProposedMatches, useTxReceiptEntry } from '@/application/receiptLinks';
import { useAttachableReceipts } from '@/application/connections';
import { useSpaceTransactions } from '@/application/transactions';
import { UNCATEGORIZED_ID } from '@/domain/categories';
import { picksSpread, picksStand, receiptLines, suggestedPicks, txMoneyOf } from '@/domain/receiptCats';
import { useCategories } from '@/features/categories/useCategories';
import { partyName } from '@/features/connectors/logos';
import type { ReceiptPick, ReceiptRow, TxSplitCat } from '@/db/types';
import type { SpaceTx } from '@/db/joined';
import { getApiCapabilities } from '@/lib/api';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { ReceiptAiRead } from './ReceiptAiRead';
import type { ReceiptReadOutcome } from './ReceiptAiRead';
import { ReceiptCaptureRungs } from './ReceiptCapture';
import { ReceiptCatsSheet } from './ReceiptCatsSheet';
import { ReceiptItems } from './ReceiptItems';
import { keepRead } from './keepRead';
import { markFreshPhoto } from './receiptAi';
import { ReceiptPickSheet, ReceiptProposalCard } from './ReceiptPickSheet';
import { applyPick, attachedElsewhere, candidatesFor, describeTxFor, dropAttached, suggestionsFor } from './receiptPick';
import { useFileByReceipt } from './useFileByReceipt';

// the ranking lives in receiptPick.ts so the review's helpers share it without importing this component
export { rankForTx } from './receiptPick';

/** more lines than this fold away: a long receipt must not bury the rest of the transaction */
const CARD_LINES = 8;

function AttachedReceiptCard({
  receipt,
  currency,
  onOpen,
  onChange,
  onCategorise,
  onRead,
  freshId,
}: Readonly<{
  receipt: ReceiptRow;
  currency: string;
  onOpen: () => void;
  onChange: () => void;
  onCategorise?: () => void;
  /** #648: a photo can be read where it was taken — absent where there is no reader or the receipt is not the person's to change */
  onRead?: (outcome: ReceiptReadOutcome) => Promise<void>;
  freshId?: string;
}>) {
  const { t, lang } = useLang();
  const photo = receipt.source === 'photo';
  const who = photo ? t('receipt.sourcePhoto') : (receipt.merchant ?? partyName(receipt.source));
  const items = receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : '';
  const picture = useReceiptFile(receipt.imageId);
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <button data-testid="receipt-card" onClick={onOpen} className="m-tap block w-full border-none bg-transparent p-0 text-left">
        {picture && <img src={picture} alt={t('receipt.title')} className="max-h-40 w-full object-cover" data-testid="receipt-card-picture" />}
        <span className="flex items-center gap-2 px-4 py-2.5">
          <Icon name={photo ? 'camera-outline' : 'storefront-outline'} size={15} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{`${who}${items}`}</span>
          <span className="m-num text-[12px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
        </span>
      </button>
      {!!receipt.items?.length && (
        <div className="border-t border-line-2 px-4" data-testid="receipt-card-items">
          <ReceiptItems items={receipt.items} currency={currency} testIdPrefix="receipt-card" limit={CARD_LINES} />
        </div>
      )}
      {onCategorise && (
        <button
          data-testid="receipt-categorise"
          onClick={onCategorise}
          className="m-tap flex w-full items-center justify-center gap-1.5 border-0 border-t border-line-2 bg-transparent py-2 text-[12px] font-medium text-accent-deep"
        >
          <Icon name="shape-outline" size={14} />
          {t('receiptcats.door')}
        </button>
      )}
      <button
        data-testid="receipt-change"
        onClick={onChange}
        className="m-tap flex w-full items-center justify-center gap-1.5 border-0 border-t border-line-2 bg-transparent py-2 text-[12px] font-medium text-accent-deep"
      >
        <Icon name="swap-horizontal" size={14} />
        {t('receipt.change')}
      </button>
      {photo && picture && onRead && <ReceiptAiRead variant="row" testIdPrefix="receipt-card-ai" images={[picture]} hasItems={!!receipt.items?.length} freshId={freshId} onRead={onRead} />}
    </div>
  );
}

/** one attach sheet serves the empty state and Change; an attached receipt leads it, marked */
export function ReceiptSection({
  tx,
  onCategorise,
}: Readonly<{
  tx: SpaceTx;
  /** #567: the transaction can be categorised by its receipt's lines — absent where its categories are not the person's to edit */
  onCategorise?: (entries: TxSplitCat[]) => void;
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store } = useData();
  const canEdit = useCanEdit();
  const aiReader = useQuery(store, async () => (await getApiCapabilities()).receiptAi === true, []) === true;
  const entry = useTxReceiptEntry(tx.id);
  const attachable = useAttachableReceipts();
  const txs = useSpaceTransactions();
  const proposals = useProposedMatches();
  const receiptOps = useReceiptOps();
  const [attachOpen, setAttachOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catsOpen, setCatsOpen] = useState(false);
  const memory = useItemMemory();
  const cats = useCategories();
  const fileByReceipt = useFileByReceipt();
  /** #567: a receipt that lands on the payment files it by its lines where both say the same amount */
  const attached = (write: Promise<unknown>) => void write.then(() => fileByReceipt(tx.id));

  const receipt = entry?.data ?? null;
  const money = useMemo(() => txMoneyOf(tx), [tx]);
  const suggestions = useMemo(() => {
    const known = (catId: string) => catId !== UNCATEGORIZED_ID && cats.byId(catId).id === catId;
    return new Map(suggestedPicks(receipt?.items, memory, known).map((pick) => [pick.line, pick.catId]));
  }, [receipt?.items, memory, cats]);
  const storedPicks = entry?.picks?.[tx.id];
  const standingPicks = picksStand(storedPicks, receipt?.items, money.held) ? (storedPicks ?? []) : [];
  const categorisable = !!onCategorise && !!entry?.linkId && receiptLines(receipt?.items).length > 0 && money.netCents > 0;

  const applyPicks = (picks: ReceiptPick[]) => {
    if (!entry?.linkId || !onCategorise) return;
    void receiptOps.setPicks(entry.linkId, tx.id, picks);
    onCategorise(picksSpread(picks, money.netCents, money.restCatId));
  };
  // #367 §5.7: a fetched receipt that fits this reviewed transaction asks first
  const proposal = receipt === null ? (proposals ?? []).find((l) => l.proposedTxId === tx.id) : undefined;
  // the attached receipt leads the lists, marked, so it is never offered twice; one attached elsewhere stays on offer
  const others = useMemo(() => (attachable?.rows ?? []).filter((r) => r.id !== receipt?.id), [attachable, receipt?.id]);
  // suggestions: unmatched receipts that fit; the proposal's receipt asks on its own card, not among them (review's rule)
  const candidates = useMemo(() => candidatesFor(tx, attachable, proposal?.receiptId), [tx, attachable, proposal?.receiptId]);
  const elsewhere = useMemo(() => attachedElsewhere(attachable?.attachedTo, tx.id), [attachable, tx.id]);
  const describeTx = useMemo(() => describeTxFor(txs, lang, tx.currency), [txs, lang, tx.currency]);

  const openReceipt = (receiptId: string) => void navigate({ to: '/receipts/$receiptId', params: { receiptId }, search: { from: tx.id } });

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      markFreshPhoto(await receiptOps.attachPhoto(tx, file));
      // taken from Change, the photo replaces the attached receipt — its link is in before the old one goes
      if (entry) await dropAttached(receiptOps, entry, tx.id);
      setAttachOpen(false);
    } finally {
      setBusy(false);
    }
  };

  if (entry === undefined) return null;
  // #496: an attached receipt leads with one more beside it; nothing attached shows the best three (#542)
  const suggested = suggestionsFor(receipt, candidates);
  const all = receipt ? [receipt, ...others] : others;

  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('receipt.title')}</div>
      {proposal && (
        <ReceiptProposalCard
          className="mb-2"
          link={proposal}
          currency={tx.currency}
          ids={{ card: 'receipt-proposal', accept: 'receipt-proposal-accept', reject: 'receipt-proposal-reject' }}
          onAccept={(link) => attached(receiptOps.acceptMatch(link))}
          onReject={(link) => void receiptOps.rejectMatch(link)}
        />
      )}
      {receipt === null ? (
        <button
          data-testid="receipt-empty"
          onClick={() => setAttachOpen(true)}
          className="m-tap flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-surface px-4 py-3 text-left"
        >
          <Icon name="receipt-text-plus-outline" size={18} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1 text-[13px] font-medium text-accent-deep">{t('receipt.attach')}</span>
          {suggested.length > 0 && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-deep" data-testid="receipt-candidate-count">
              {suggested.length}
            </span>
          )}
        </button>
      ) : (
        <AttachedReceiptCard
          receipt={receipt}
          currency={tx.currency}
          onOpen={() => openReceipt(receipt.id)}
          onChange={() => setAttachOpen(true)}
          onCategorise={categorisable ? () => setCatsOpen(true) : undefined}
          onRead={aiReader && canEdit && entry ? (outcome) => keepRead(receiptOps, fileByReceipt, entry, outcome) : undefined}
          freshId={entry?.linkId}
        />
      )}
      <ReceiptCatsSheet
        open={catsOpen}
        onOpenChange={setCatsOpen}
        items={receipt?.items}
        currency={tx.currency}
        netCents={money.netCents}
        settledCents={money.settledCents}
        restCatId={money.restCatId}
        initial={standingPicks}
        suggestions={suggestions}
        onApply={applyPicks}
      />

      <ReceiptPickSheet
        open={attachOpen}
        onOpenChange={setAttachOpen}
        title={t('receipt.attach')}
        testIdPrefix="receipt-pick"
        pickTestIdPrefix="receipt-pick"
        proposal={proposal}
        proposalTx={proposal ? tx : undefined}
        candidates={suggested}
        all={all}
        selectedId={receipt?.id ?? null}
        attachedId={receipt?.id ?? null}
        showNone={receipt !== null}
        currency={tx.currency}
        attachedTo={elsewhere}
        describeTx={describeTx}
        onAccept={(link) => {
          attached(receiptOps.acceptMatch(link));
          setAttachOpen(false);
        }}
        onReject={(link) => {
          void receiptOps.rejectMatch(link);
          setAttachOpen(false);
        }}
        onPick={(row) => {
          setAttachOpen(false);
          if (row) attached(applyPick(receiptOps, tx.id, entry, row));
          else void applyPick(receiptOps, tx.id, entry, row);
        }}
      >
        <ReceiptCaptureRungs testIdPrefix="receipt" busy={busy} onFile={(file) => void onFile(file)} onConnections={() => void navigate({ to: '/connections' })} />
      </ReceiptPickSheet>
    </>
  );
}
