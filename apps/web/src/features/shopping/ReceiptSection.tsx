import { useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
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
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { ReceiptCaptureRungs } from './ReceiptCapture';
import { ReceiptCatsSheet } from './ReceiptCatsSheet';
import { ReceiptPickSheet, ReceiptProposalCard } from './ReceiptPickSheet';
import { applyPick, attachedElsewhere, candidatesFor, describeTxFor, dropAttached, suggestionsFor } from './receiptPick';
import { useFileByReceipt } from './useFileByReceipt';

// the ranking lives in receiptPick.ts (user 2026-10-07: the review's helpers
// share it without importing this component); its old door stays open
export { rankForTx } from './receiptPick';

/** the attached receipt (user 2026-10-07: "see which one is attached and change it"):
 *  the card opens it, Change opens the picker with it marked */
function AttachedReceiptCard({
  receipt,
  currency,
  onOpen,
  onChange,
  onCategorise,
}: Readonly<{ receipt: ReceiptRow; currency: string; onOpen: () => void; onChange: () => void; onCategorise?: () => void }>) {
  const { t, lang } = useLang();
  const photo = receipt.source === 'photo';
  const who = photo ? t('receipt.sourcePhoto') : (receipt.merchant ?? partyName(receipt.source));
  const items = receipt.items?.length ? ` · ${receipt.items.length} ${t('receipt.items')}` : '';
  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <button data-testid="receipt-card" onClick={onOpen} className="m-tap block w-full border-none bg-transparent p-0 text-left">
        {receipt.image && <img src={receipt.image} alt={t('receipt.title')} className="max-h-40 w-full object-cover" />}
        <span className="flex items-center gap-2 px-4 py-2.5">
          <Icon name={photo ? 'camera-outline' : 'storefront-outline'} size={15} color="var(--m-ink-3)" />
          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{`${who}${items}`}</span>
          <span className="m-num text-[12px] font-semibold text-ink">{fmtCents(receipt.totalCents, currency, lang)}</span>
        </span>
      </button>
      <button
        data-testid="receipt-change"
        onClick={onChange}
        className="m-tap flex w-full items-center justify-center gap-1.5 border-0 border-t border-line-2 bg-transparent py-2 text-[12px] font-medium text-accent-deep"
      >
        <Icon name="swap-horizontal" size={14} />
        {t('receipt.change')}
      </button>
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
    </div>
  );
}

/**
 * The transaction's line-item proof (receipts v3, R8 redesign): the
 * empty state opens ONE attach sheet — best-matching unlinked store
 * receipts first, camera/upload and the connections door as the
 * fallback rungs, then every receipt behind a search (user 2026-10-07:
 * the review's picker, shared) — and an attached receipt leads that
 * same sheet, marked, so it can be changed.
 */
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
  // the receipts on offer: every receipt of the included shops, the attached one never twice (it leads the lists,
  // marked); user 2026-10-08: one attached elsewhere stays on offer — its row says where it already sits
  const others = useMemo(() => (attachable?.rows ?? []).filter((r) => r.id !== receipt?.id), [attachable, receipt?.id]);
  // the suggestions: the unmatched receipts that fit; the proposal's receipt asks on its own card, not among them
  // (the review's rule)
  const candidates = useMemo(() => candidatesFor(tx, attachable, proposal?.receiptId), [tx, attachable, proposal?.receiptId]);
  const elsewhere = useMemo(() => attachedElsewhere(attachable?.attachedTo, tx.id), [attachable, tx.id]);
  const describeTx = useMemo(() => describeTxFor(txs, lang, tx.currency), [txs, lang, tx.currency]);

  /** the receipt screen, back here on return — the card's own door */
  const openReceipt = (receiptId: string) => void navigate({ to: '/receipts/$receiptId', params: { receiptId }, search: { from: tx.id } });

  const onFile = async (file: File) => {
    setBusy(true);
    try {
      await receiptOps.attachPhoto(tx, file);
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

      {/* ONE attach flow (user: the old scatter felt odd): the attached receipt and the
          suggestions lead, capture and the stores door follow, every receipt sits behind
          the search — the review card's sheet, shared (user 2026-10-07) */}
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
