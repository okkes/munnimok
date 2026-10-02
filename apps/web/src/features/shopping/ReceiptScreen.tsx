import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { LOCALES, useLang } from '@/i18n';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { useReceiptOps } from '@/application/receipts';
import { connectorsAvailable, useStoreConnMetas } from '@/application/connections';
import { globalAsEntry, linkAsEntry, spaceReceipts } from '@/application/receiptLinks';
import type { ReceiptEntry } from '@/application/receiptLinks';
import { myStoreFeedId } from '@/application/storeFeed';
import { useSpaceTransactions } from '@/application/transactions';
import { candidateLadder, parseReceiptText } from '@/domain/storeReceipts';
import { partyName } from '@/features/connectors/logos';
import { apiFetch } from '@/lib/api';
import { fmtCents } from '@/lib/money';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { TxRow } from '@/ui/TxRow';
import type { ReceiptDocument, ReceiptRow } from '@/db/types';
import type { StorageBackend } from '@/db/backend';

/** where a receipt is looked at from: a space (links, matching) or the connections hub (the party's own list) */
export type ReceiptScope = 'space' | 'global';

type Translate = ReturnType<typeof useLang>['t'];

/** what the screen is called after: the merchant or the party, Photo for a snapped one */
const titleOf = (receipt: ReceiptRow | null, t: Translate): string => {
  if (!receipt) return t('receipt.title');
  if (receipt.source === 'photo') return t('receipt.sourcePhoto');
  return receipt.merchant ?? partyName(receipt.source);
};

/** an invoice the party issued, shown in place — a PDF or a picture, from its data URL */
function InvoiceSheet({ document, onClose }: Readonly<{ document: ReceiptDocument | null; onClose: () => void }>) {
  const { t } = useLang();
  return (
    <Sheet open={document !== null} onOpenChange={(open) => !open && onClose()} title={t('receipts.invoice')} size="tall">
      {document && (
        <div className="flex flex-col gap-2" data-testid="receipt-invoice-view">
          {document.mime.startsWith('image/') ? (
            <img src={document.dataUrl} alt={t('receipts.invoice')} className="w-full rounded-card object-contain" />
          ) : (
            <iframe title={document.filename ?? t('receipts.invoice')} src={document.dataUrl} className="w-full rounded-card border border-line bg-white" style={{ height: 460 }} />
          )}
          <a
            data-testid="receipt-invoice-download"
            href={document.dataUrl}
            download={document.filename ?? 'invoice'}
            className="m-tap flex items-center justify-center gap-2 rounded-input border border-line bg-surface px-4 py-3 text-[14px] font-medium text-accent-deep no-underline"
          >
            <Icon name="download-outline" size={16} />
            {document.filename ?? t('receipts.invoice')}
          </a>
        </div>
      )}
    </Sheet>
  );
}

const globalRow = async (store: StorageBackend, receiptId: string): Promise<ReceiptRow | undefined> => {
  const feedId = myStoreFeedId();
  if (!feedId) return undefined;
  return (await store.bySpace('receipt', feedId)).find((r) => r.deleted === 0 && r.id === receiptId);
};

/** the receipt as the scope sees it: a space's link first, else the owner's global row; null when gone */
async function findEntry(store: StorageBackend, scope: ReceiptScope, spaceId: string, receiptId: string): Promise<ReceiptEntry | null> {
  if (scope === 'space') {
    const link = (await spaceReceipts(store, spaceId)).find((l) => (l.receiptId ?? l.id) === receiptId);
    if (link) return linkAsEntry(link);
  }
  const row = await globalRow(store, receiptId);
  return row ? globalAsEntry(row) : null;
}

/**
 * One receipt, full screen (user request 2026-10-02: the sheet was
 * cramped). From a space it carries the matching: the transaction it
 * proves, or the ladder to link it; from the connections hub it is the
 * party's document as fetched — no matched/unmatched, no linking, which
 * are a space's business.
 */
export function ReceiptScreen({
  scope,
  receiptId,
  contextTxId,
}: Readonly<{
  scope: ReceiptScope;
  receiptId: string;
  /** the transaction the screen was opened FROM — its own row is noise there */
  contextTxId?: string;
}>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const { store, spaceId } = useData();
  const txs = useSpaceTransactions();
  const metas = useStoreConnMetas();
  const receiptOps = useReceiptOps();
  const space = useQuery(store, async () => store.get('space', spaceId), [spaceId]);
  const entry = useQuery(store, async () => findEntry(store, scope, spaceId, receiptId), [scope, spaceId, receiptId]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [picking, setPicking] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [ocrState, setOcrState] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [invoice, setInvoice] = useState<ReceiptDocument | null>(null);

  const receipt = entry?.data ?? null;

  useEffect(() => {
    setConfirmDelete(false);
    setPicking(false);
    setShowMore(false);
    setOcrState('idle');
    setInvoice(null);
  }, [receipt?.id]);

  const currency = receipt?.currency ?? space?.currency ?? 'EUR';
  const money = (cents: number) => fmtCents(cents, currency, lang);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
  const back = () => window.history.back();
  /** after a delete there is nothing to come back to: the place the receipt was opened from, by name */
  const leave = () => {
    if (contextTxId) void navigate({ to: '/transactions/$txId', params: { txId: contextTxId } });
    else void navigate({ to: scope === 'global' ? '/connections/receipts' : '/receipts' });
  };

  const linkedTxId = scope === 'space' ? entry?.txId : undefined;
  const linkedTx = linkedTxId ? txs?.find((tx) => tx.id === linkedTxId) : undefined;
  const ladder = receipt && scope === 'space' ? candidateLadder(receipt, txs ?? []) : { primary: [], more: [] };
  const candidates = () => (showMore ? [...ladder.primary, ...ladder.more] : ladder.primary);
  const photoBorn = entry?.kind === 'link' && entry.data.source === 'photo';
  const connection = receipt?.instanceId ? metas?.find((m) => m.id === receipt.instanceId) : undefined;

  const readItems = async () => {
    if (!receipt?.image || !entry?.linkId) return;
    setOcrState('busy');
    try {
      const response = await apiFetch('/ocr/receipt', { method: 'POST', body: JSON.stringify({ image: receipt.image }) });
      if (!response.ok) {
        setOcrState('failed');
        return;
      }
      const { text } = (await response.json()) as { text: string };
      const items = parseReceiptText(text);
      if (items.length === 0) {
        setOcrState('failed');
        return;
      }
      await receiptOps.setItems(entry.linkId, items);
      setOcrState('idle');
    } catch {
      setOcrState('failed');
    }
  };

  // a store receipt's link "deletes" by unlinking — the wording must say so
  const deleteLabel = entry?.kind === 'link' && !photoBorn ? t('receipt.unlink') : t('action.delete');

  const removeReceipt = async () => {
    if (!entry) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    // each kind deletes in its own store: drop the photo, unlink the
    // store snapshot, or drop the global receipt
    if (entry.kind === 'global') await receiptOps.removeGlobalReceipt(entry.data.id);
    else if (entry.linkId) await (photoBorn ? receiptOps.remove(entry.linkId) : receiptOps.unlinkReceipt(entry.linkId));
    leave();
  };

  const title = titleOf(receipt, t);

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-receipt">
      <AppBar
        title={title}
        leading={
          <IconButton label={t('action.back')} testId="receipt-back" onClick={back}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-8">
        {entry === null && (
          <div className="flex flex-col items-center gap-2 px-6 pt-16 text-center" data-testid="receipt-missing">
            <Icon name="receipt-text-outline" size={34} color="var(--m-ink-4)" />
            <p className="text-[13px] text-ink-4">{t('receipt.missing')}</p>
          </div>
        )}
        {entry && receipt && (
          <div className="flex flex-col gap-3 pt-1">
            {/* the headline: who, when, how much */}
            <div className="rounded-card border border-line bg-surface px-4 py-4" data-testid="receipt-head">
              <div className="flex items-start gap-3">
                <Icon name={receipt.source === 'photo' ? 'camera-outline' : 'storefront-outline'} size={22} color="var(--m-accent-deep)" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-medium text-ink">{title}</span>
                  <span className="block text-[12px] text-ink-3" data-testid="receipt-view-date">
                    {fmtDate(receipt.date)}
                  </span>
                  {connection && (
                    <span className="block text-[11px] text-ink-4" data-testid="receipt-connection">
                      {t('receipt.fromConnection', { name: connection.displayName })}
                    </span>
                  )}
                </span>
              </div>
              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-[12px] text-ink-3">{t('receipt.total')}</span>
                <span className="m-num text-[24px] font-semibold text-ink" data-testid="receipt-view-total">
                  {money(receipt.totalCents)}
                </span>
              </div>
              {receipt.payment?.method && (
                <p className="mt-1 text-right text-[11px] text-ink-4" data-testid="receipt-payment">
                  {receipt.payment.method}
                  {receipt.payment.accountTail ? ` · …${receipt.payment.accountTail}` : ''}
                </p>
              )}
            </div>

            {receipt.image && <img src={receipt.image} alt={t('receipt.title')} className="w-full rounded-card object-contain" style={{ maxHeight: 520 }} />}

            {!!receipt.items?.length && (
              <div>
                <div className="m-cap mb-1 px-1">
                  {t('receipt.itemsTitle')} · {receipt.items.length}
                </div>
                <div className="rounded-card border border-line bg-surface px-4 py-1" data-testid="receipt-items">
                  {receipt.items.map((item) => (
                    <div key={`${item.name}-${item.totalCents}`} className="flex items-baseline gap-2 border-b border-line-2 py-2.5 text-[13px] last:border-0">
                      <span className="min-w-0 flex-1 text-ink">{item.name}</span>
                      {item.qty !== undefined && <span className="text-[11px] text-ink-4">×{item.qty}</span>}
                      <span className="m-num text-ink">{money(item.totalCents)}</span>
                    </div>
                  ))}
                </div>
                {receipt.reconciled === false && (
                  <p className="mt-1 px-1 text-[11px] text-ink-4" data-testid="receipt-unreconciled">
                    {t('receipt.unreconciled')}
                  </p>
                )}
              </div>
            )}

            {/* #367: the invoices the party issued for this purchase */}
            {!!receipt.documents?.length && (
              <div>
                <div className="m-cap mb-1 px-1">{t('receipts.invoice')}</div>
                <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid="receipt-documents">
                  {receipt.documents.map((document, index) => (
                    <button
                      key={`${document.filename ?? document.kind}-${index}`}
                      data-testid={`receipt-document-${index}`}
                      onClick={() => setInvoice(document)}
                      className="m-tap flex w-full items-center gap-3 border-b border-line-2 bg-transparent px-4 py-3 text-left last:border-0"
                    >
                      <Icon name="file-pdf-box" size={18} color="var(--m-ink-3)" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{document.filename ?? t('receipts.invoice')}</span>
                      <span className="text-[12px] font-medium text-accent-deep">{t('receipts.openInvoice')}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {scope === 'space' ? (
              <>
                {/* the transaction this receipt proves — hidden when the screen
                    was opened from that very transaction (self-reference) */}
                {linkedTx && linkedTx.id !== contextTxId && (
                  <div>
                    <div className="m-cap mb-1 px-1">{t('receipt.linkedTitle')}</div>
                    <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3" data-testid="receipt-linked-tx">
                      <TxRow tx={linkedTx} showDate onClick={() => void navigate({ to: '/transactions/$txId', params: { txId: linkedTx.id } })} />
                    </div>
                  </div>
                )}
                {!linkedTxId && (
                  <>
                    <Button variant="outline" className="w-full" data-testid="receipt-link-tx" onClick={() => setPicking((v) => !v)}>
                      {t('receipts.pickTx')}
                    </Button>
                    {picking && (
                      <div className="divide-y divide-line-2 rounded-card border border-line bg-surface px-3" data-testid="receipt-candidates">
                        {candidates().map((tx) => (
                          <TxRow
                            key={tx.id}
                            tx={tx}
                            showDate
                            onClick={() => {
                              void receiptOps.linkReceipt(receipt, tx.id);
                              setPicking(false);
                            }}
                          />
                        ))}
                        {!showMore && ladder.more.length > 0 && (
                          <button
                            data-testid="receipt-show-more"
                            onClick={() => setShowMore(true)}
                            className="m-tap flex w-full items-center justify-center gap-1 border-none bg-transparent py-2.5 text-[13px] font-medium text-accent-deep"
                          >
                            {t('receipts.showMore', { n: ladder.more.length })}
                            <Icon name="chevron-down" size={15} />
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )}
                {photoBorn && !receipt.items?.length && connectorsAvailable() && (
                  <>
                    <Button variant="outline" className="w-full" data-testid="receipt-read-items" disabled={ocrState === 'busy'} onClick={() => void readItems()}>
                      {t('receipt.readItems')}
                    </Button>
                    {ocrState === 'failed' && (
                      <p className="text-center text-[12px] text-ink-4" data-testid="receipt-read-failed">
                        {t('receipt.readFailed')}
                      </p>
                    )}
                  </>
                )}
              </>
            ) : (
              <p className="px-1 text-[11px] leading-snug text-ink-4" data-testid="receipt-space-hint">
                {t('receipt.spaceHint')}
              </p>
            )}

            <Button variant="danger" className="w-full" data-testid="receipt-delete" onClick={() => void removeReceipt()}>
              {confirmDelete ? t('action.confirm') : deleteLabel}
            </Button>
          </div>
        )}
      </div>
      <InvoiceSheet document={invoice} onClose={() => setInvoice(null)} />
    </div>
  );
}
