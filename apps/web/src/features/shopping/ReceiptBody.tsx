import { useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import type { TFunc } from '@/i18n';
import { partyName } from '@/features/connectors/logos';
import { fmtCents } from '@/lib/money';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';
import { PdfView } from './PdfView';
import type { ReceiptDocument, ReceiptRow } from '@/db/types';

/** what a receipt is called: the merchant or the party, Photo for a snapped one */
export const receiptTitle = (receipt: ReceiptRow, t: TFunc): string => {
  if (receipt.source === 'photo') return t('receipt.sourcePhoto');
  return receipt.merchant ?? partyName(receipt.source);
};

/** an invoice the party issued, shown in place — a PDF or a picture, from
 *  its data URL. User 2026-10-06: the sheet takes the whole height (the
 *  wide dialog on a desktop) and a PDF is drawn by pdf.js at the frame's
 *  width with zoom on top — the browser's own plugin fit the page instead,
 *  zoomed as it pleased, and Android had none. */
function InvoiceSheet({ document, onClose, testIdPrefix }: Readonly<{ document: ReceiptDocument | null; onClose: () => void; testIdPrefix: string }>) {
  const { t } = useLang();
  return (
    <Sheet open={document !== null} onOpenChange={(open) => !open && onClose()} title={t('receipts.invoice')} size="full" wide>
      {document && (
        <div className="flex flex-col gap-2" data-testid={`${testIdPrefix}-invoice-view`}>
          {document.mime.startsWith('image/') ? (
            <div className="h-[calc(100dvh-250px)] overflow-auto rounded-card border border-line bg-bg-2 lg:h-[min(calc(92dvh-250px),760px)]" data-sheet-no-drag>
              <img src={document.dataUrl} alt={t('receipts.invoice')} className="w-full" />
            </div>
          ) : (
            <PdfView dataUrl={document.dataUrl} testId={`${testIdPrefix}-pdf`} />
          )}
          <a
            data-testid={`${testIdPrefix}-invoice-download`}
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

/**
 * A receipt's body — the headline (who, when, how much), the picture, the
 * line items and the party's invoices opened in place. The receipt screen
 * and the picker's peek sheet render the same thing (user 2026-10-09: a
 * look at a receipt must not break the attach flow), so the screen keeps
 * the actions (link, unlink, delete) and the peek shows only this.
 */
export function ReceiptBody({
  receipt,
  currency,
  connectionName,
  testIdPrefix = 'receipt',
}: Readonly<{
  receipt: ReceiptRow;
  currency: string;
  /** the connection that fetched it, when known ("From Albert Heijn") */
  connectionName?: string;
  /** the screen keeps `receipt-…`; the peek sheet wears its own prefix so both can stand at once */
  testIdPrefix?: string;
}>) {
  const { t, lang } = useLang();
  const [invoice, setInvoice] = useState<ReceiptDocument | null>(null);
  const id = (suffix: string): string => `${testIdPrefix}-${suffix}`;
  const money = (cents: number) => fmtCents(cents, currency, lang);
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString(LOCALES[lang], { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });

  return (
    <>
      {/* the headline: who, when, how much */}
      <div className="rounded-card border border-line bg-surface px-4 py-4" data-testid={id('head')}>
        <div className="flex items-start gap-3">
          <Icon name={receipt.source === 'photo' ? 'camera-outline' : 'storefront-outline'} size={22} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-medium text-ink">{receiptTitle(receipt, t)}</span>
            <span className="block text-[12px] text-ink-3" data-testid={id('view-date')}>
              {fmtDate(receipt.date)}
            </span>
            {connectionName && (
              <span className="block text-[11px] text-ink-4" data-testid={id('connection')}>
                {t('receipt.fromConnection', { name: connectionName })}
              </span>
            )}
          </span>
        </div>
        <div className="mt-3 flex items-baseline justify-between">
          <span className="text-[12px] text-ink-3">{t('receipt.total')}</span>
          <span className="m-num text-[24px] font-semibold text-ink" data-testid={id('view-total')}>
            {money(receipt.totalCents)}
          </span>
        </div>
        {receipt.payment?.method && (
          <p className="mt-1 text-right text-[11px] text-ink-4" data-testid={id('payment')}>
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
          <div className="rounded-card border border-line bg-surface px-4 py-1" data-testid={id('items')}>
            {receipt.items.map((item) => (
              <div key={`${item.name}-${item.totalCents}`} className="flex items-baseline gap-2 border-b border-line-2 py-2.5 text-[13px] last:border-0">
                <span className="min-w-0 flex-1 text-ink">{item.name}</span>
                {item.qty !== undefined && <span className="text-[11px] text-ink-4">×{item.qty}</span>}
                <span className="m-num text-ink">{money(item.totalCents)}</span>
              </div>
            ))}
          </div>
          {receipt.reconciled === false && (
            <p className="mt-1 px-1 text-[11px] text-ink-4" data-testid={id('unreconciled')}>
              {t('receipt.unreconciled')}
            </p>
          )}
        </div>
      )}

      {/* #367: the invoices the party issued for this purchase */}
      {!!receipt.documents?.length && (
        <div>
          <div className="m-cap mb-1 px-1">{t('receipts.invoice')}</div>
          <div className="overflow-hidden rounded-card border border-line bg-surface" data-testid={id('documents')}>
            {receipt.documents.map((document, index) => (
              <button
                key={`${document.filename ?? document.kind}-${index}`}
                data-testid={id(`document-${index}`)}
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
      <InvoiceSheet document={invoice} onClose={() => setInvoice(null)} testIdPrefix={testIdPrefix} />
    </>
  );
}
