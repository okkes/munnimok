import { useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useLgViewport } from '@/lib/viewport';
import { useReceiptOps } from '@/application/receipts';
import type { ReceiptOps } from '@/application/receipts';
import { useProposedMatches, useTxReceiptEntry } from '@/application/receiptLinks';
import type { ReceiptEntry } from '@/application/receiptLinks';
import { useUnmatchedReceipts } from '@/application/connections';
import { partyName } from '@/features/connectors/logos';
import type { ReceiptRow } from '@/db/types';
import type { SpaceTx } from '@/db/joined';
import { fmtCents } from '@/lib/money';
import { isNativeApp, takeNativePhoto } from '@/lib/platform';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { WebcamCaptureSheet, useWebcamDoor } from '@/ui/WebcamCaptureSheet';
import { ReceiptPickSheet, ReceiptProposalCard } from './ReceiptPickSheet';
import { rankForTx } from './receiptPick';

// the ranking lives in receiptPick.ts (user 2026-10-07: the review's helpers
// share it without importing this component); its old door stays open
export { rankForTx };

/** the attached receipt lets go: a photo is gone for good, a store receipt is unmatched again */
async function dropAttached(ops: ReceiptOps, attached: ReceiptEntry): Promise<void> {
  if (!attached.linkId) return;
  if (attached.data.source === 'photo') await ops.remove(attached.linkId);
  else await ops.unlinkReceipt(attached.linkId);
}

/** what a tap in the sheet does: a receipt attaches (in the attached one's place when there is one), None lets it go */
async function applyPick(ops: ReceiptOps, txId: string, attached: ReceiptEntry | null, row: ReceiptRow | null): Promise<void> {
  if (row?.id === attached?.data.id) return; // the attached one again, or None with nothing attached: nothing changes
  if (row && attached?.linkId) await ops.swapReceipt(attached.linkId, row, txId);
  else if (row) await ops.linkReceipt(row, txId);
  else if (attached) await dropAttached(ops, attached);
}

/** the attached receipt (user 2026-10-07: "see which one is attached and change it"):
 *  the card opens it, Change opens the picker with it marked */
function AttachedReceiptCard({
  receipt,
  currency,
  onOpen,
  onChange,
}: Readonly<{ receipt: ReceiptRow; currency: string; onOpen: () => void; onChange: () => void }>) {
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
    </div>
  );
}

/** the sheet's own rungs under the suggestions: capture or upload, the desktop webcam (#160), the stores door */
function AttachRungs({
  busy,
  webcam,
  onTakePhoto,
  onWebcam,
  onConnections,
}: Readonly<{ busy: boolean; webcam: boolean; onTakePhoto: () => void; onWebcam: () => void; onConnections: () => void }>) {
  const { t } = useLang();
  const panes = useLgViewport();
  return (
    <>
      <Button variant="outline" className="w-full" data-testid="receipt-take-photo" disabled={busy} onClick={onTakePhoto}>
        <Icon name={panes ? 'upload-outline' : 'camera-outline'} size={16} />
        {panes ? t('receipt.upload') : t('receipt.takePhoto')}
      </Button>
      {/* #160: desktop webcam snapshot — same attach path as a file */}
      {webcam && (
        <Button variant="outline" className="w-full" data-testid="receipt-webcam" disabled={busy} onClick={onWebcam}>
          <Icon name="camera-outline" size={16} />
          {t('webcam.use')}
        </Button>
      )}
      <button
        data-testid="receipt-connections"
        onClick={onConnections}
        className="m-tap border-none bg-transparent py-1 text-center text-[12px] font-medium text-accent-deep"
      >
        {t('conn.title')}
      </button>
    </>
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
export function ReceiptSection({ tx }: Readonly<{ tx: SpaceTx }>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const entry = useTxReceiptEntry(tx.id);
  const unmatched = useUnmatchedReceipts();
  const proposals = useProposedMatches();
  const receiptOps = useReceiptOps();
  const fileRef = useRef<HTMLInputElement>(null);
  const [attachOpen, setAttachOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // #160: desktop-only webcam rung under the upload button (hooks stay
  // above the `entry === undefined` early return)
  const webcamDoor = useWebcamDoor();
  const [webcamOpen, setWebcamOpen] = useState(false);

  const receipt = entry?.data ?? null;
  // #367 §5.7: a fetched receipt that fits this reviewed transaction asks first
  const proposal = receipt === null ? (proposals ?? []).find((l) => l.proposedTxId === tx.id) : undefined;
  // the receipts on offer: never the attached one twice (it leads the lists, marked)
  const others = useMemo(() => (unmatched ?? []).filter((r) => r.id !== receipt?.id), [unmatched, receipt?.id]);
  // the proposal's receipt asks on its own card, not among the suggestions (the review's rule)
  const candidates = useMemo(
    () => rankForTx(tx, others.filter((r) => r.id !== proposal?.receiptId)).slice(0, 6),
    [tx, others, proposal?.receiptId],
  );

  /** the receipt screen, back here on return — the card's own door and the sheet's eye alike */
  const openReceipt = (receiptId: string) => void navigate({ to: '/receipts/$receiptId', params: { receiptId }, search: { from: tx.id } });

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await receiptOps.attachPhoto(tx, file);
      // taken from Change, the photo replaces the attached receipt — its link is in before the old one goes
      if (entry) await dropAttached(receiptOps, entry);
      setAttachOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const takePhoto = () => {
    // shells use the Camera plugin: the webview <input capture> path
    // crashed on iOS and offered gallery-only on Android
    if (isNativeApp()) void takeNativePhoto().then((file) => onFile(file ?? undefined));
    else fileRef.current?.click();
  };

  if (entry === undefined) return null;
  const suggested = receipt ? [receipt, ...candidates] : candidates;
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
          onAccept={(link) => void receiptOps.acceptMatch(link)}
          onReject={(link) => void receiptOps.rejectMatch(link)}
        />
      )}
      <input
        ref={fileRef}
        data-testid="receipt-file"
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => void onFile(e.target.files?.[0])}
      />
      {receipt === null ? (
        <button
          data-testid="receipt-empty"
          onClick={() => setAttachOpen(true)}
          className="m-tap flex w-full items-center gap-3 rounded-card border border-dashed border-line bg-surface px-4 py-3 text-left"
        >
          <Icon name="receipt-text-plus-outline" size={18} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1 text-[13px] font-medium text-accent-deep">{t('receipt.attach')}</span>
          {candidates.length > 0 && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[10px] font-semibold text-accent-deep" data-testid="receipt-candidate-count">
              {candidates.length}
            </span>
          )}
        </button>
      ) : (
        <AttachedReceiptCard receipt={receipt} currency={tx.currency} onOpen={() => openReceipt(receipt.id)} onChange={() => setAttachOpen(true)} />
      )}

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
        candidates={suggested}
        all={all}
        selectedId={receipt?.id ?? null}
        showNone={receipt !== null}
        currency={tx.currency}
        onAccept={(link) => {
          void receiptOps.acceptMatch(link);
          setAttachOpen(false);
        }}
        onReject={(link) => {
          void receiptOps.rejectMatch(link);
          setAttachOpen(false);
        }}
        onPick={(row) => {
          setAttachOpen(false);
          void applyPick(receiptOps, tx.id, entry, row);
        }}
        onView={openReceipt}
      >
        <AttachRungs
          busy={busy}
          webcam={webcamDoor}
          onTakePhoto={takePhoto}
          onWebcam={() => setWebcamOpen(true)}
          onConnections={() => void navigate({ to: '/connections' })}
        />
      </ReceiptPickSheet>

      {/* #160: snapshot rides the same attach pipeline as a picked file */}
      <WebcamCaptureSheet open={webcamOpen} onOpenChange={setWebcamOpen} onCapture={(file) => void onFile(file)} />
    </>
  );
}
