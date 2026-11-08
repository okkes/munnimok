import { useMemo, useRef, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { useAttachableReceipts } from '@/application/connections';
import { useProposedMatches, useTxReceiptEntry } from '@/application/receiptLinks';
import { useReceiptOps } from '@/application/receipts';
import { useSpaceTransactions } from '@/application/transactions';
import type { SpaceTx } from '@/db/joined';
import type { ReceiptRow } from '@/db/types';
import { autoReceiptFor } from '@/features/review/reviewReceipt';
import { fmtCents } from '@/lib/money';
import { txTitle } from '@/lib/text';
import { InfoHint } from '@/ui/InfoHint';
import { ReceiptCaptureRungs } from './ReceiptCapture';
import { ReceiptPickSheet } from './ReceiptPickSheet';
import { applyPick, attachedElsewhere, candidatesFor, describeTxFor, suggestionsFor } from './receiptPick';

/** one sibling's turn: the picker for THIS transaction, its head naming it */
function ReceiptQueueStep({
  tx,
  step,
  onAnswered,
  onSkip,
  onStop,
}: Readonly<{ tx: SpaceTx; step: string; onAnswered: () => void; onSkip: () => void; onStop: () => void }>) {
  const { t, lang } = useLang();
  const attachable = useAttachableReceipts();
  const proposals = useProposedMatches();
  const entry = useTxReceiptEntry(tx.id);
  const txs = useSpaceTransactions();
  const ops = useReceiptOps();
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const proposal = (proposals ?? []).find((link) => link.proposedTxId === tx.id && !link.txId);
  const candidates = useMemo(() => candidatesFor(tx, attachable, proposal?.receiptId), [tx, attachable, proposal?.receiptId]);
  const elsewhere = useMemo(() => attachedElsewhere(attachable?.attachedTo, tx.id), [attachable, tx.id]);
  const describeTx = useMemo(() => describeTxFor(txs, lang, tx.currency), [txs, lang, tx.currency]);
  const attached = entry?.data ?? null;
  // the fit this transaction's own review card would have staged wears the check
  const auto = proposal || attached ? null : autoReceiptFor(tx, candidates);

  /** one answer per turn: the write lands, then the walk moves on */
  const answer = async (work: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await work();
    } finally {
      working.current = false;
      setBusy(false);
    }
    onAnswered();
  };
  /** a pick: the proposal's own receipt is its yes, any other turns the proposal down; none lets it go */
  const pick = (row: ReceiptRow | null) =>
    answer(async () => {
      if (row && proposal && (proposal.receiptId ?? proposal.id) === row.id) {
        await ops.acceptMatch(proposal);
        return;
      }
      if (proposal) await ops.rejectMatch(proposal);
      await applyPick(ops, tx.id, entry ?? null, row);
    });

  const context = (
    <div className="rounded-card border border-accent/40 bg-accent-soft/30 px-3 py-2" data-testid="receipt-queue-context">
      <div className="m-cap flex items-center gap-1 pb-0.5 text-accent-deep">
        <span className="min-w-0 flex-1">
          {t('receipt.queueFor')} · {step}
        </span>
        <InfoHint text={t('receipt.queueWhy')} testId="receipt-queue-why" />
        <button
          data-testid="receipt-queue-skip"
          disabled={busy}
          onClick={onSkip}
          className="m-tap ml-2 border-none bg-transparent p-0 text-[12px] font-semibold tracking-normal text-accent-deep normal-case disabled:opacity-40"
        >
          {t('receipt.queueSkip')}
        </button>
      </div>
      <p className="truncate text-[13px] font-medium text-ink">{txTitle(tx)}</p>
      <p className="text-[12px] text-ink-3">
        {new Date(tx.date).toLocaleDateString(LOCALES[lang], { day: 'numeric', month: 'short', year: 'numeric' })}
        {' · '}
        {fmtCents(tx.amountCents, tx.currency, lang, { sign: true })}
      </p>
    </div>
  );

  return (
    <ReceiptPickSheet
      open
      onOpenChange={(next) => {
        if (!next) onStop();
      }}
      title={t('receipt.title')}
      testIdPrefix="receipt-queue"
      proposal={proposal}
      proposalTx={proposal ? tx : undefined}
      candidates={suggestionsFor(attached, candidates)}
      all={attachable?.rows ?? []}
      selectedId={attached?.id ?? auto?.id ?? null}
      attachedId={attached?.id ?? null}
      currency={tx.currency}
      attachedTo={elsewhere}
      describeTx={describeTx}
      onAccept={(link) => void answer(() => ops.acceptMatch(link))}
      // a "no" to the proposal keeps this turn open: another pick, No receipt or Skip follows
      onReject={(link) => void ops.rejectMatch(link)}
      onPick={(row) => void pick(row)}
      context={context}
    >
      <ReceiptCaptureRungs testIdPrefix="receipt-queue" busy={busy} onFile={(file) => void answer(() => ops.attachPhoto(tx, file))} />
    </ReceiptPickSheet>
  );
}

/**
 * #495 (user): "just like how we go through each transaction to check the
 * counter transaction" — a bulk update settles the siblings without their
 * own review card, so the ones whose receipt wants a look (receiptsToVerify)
 * get the picker in turn: a look and Attach or the proposal's yes links it,
 * No receipt turns a proposal down, Skip leaves it as it is. Dismissing the
 * sheet stops the walk; the rest stay untouched.
 */
export function BulkReceiptQueue({
  queue,
  onDone,
}: Readonly<{
  queue: readonly SpaceTx[];
  /** fires once — the walk is through or was dismissed (every answer logged its own activity line) */
  onDone: () => void;
}>) {
  const [index, setIndex] = useState(0);
  const current = queue[index];
  if (!current) return null;
  const next = () => {
    if (index + 1 >= queue.length) onDone();
    else setIndex(index + 1);
  };
  return <ReceiptQueueStep key={current.id} tx={current} step={`${index + 1}/${queue.length}`} onAnswered={next} onSkip={next} onStop={onDone} />;
}
