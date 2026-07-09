import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useReceiptOps, useTxReceipt } from '@/application/receipts';
import { storesAvailable } from '@/application/stores';
import { parseReceiptText } from '@/domain/storeReceipts';
import type { SpaceTx } from '@/db/joined';
import { apiFetch } from '@/lib/api';
import { fmtCents } from '@/lib/money';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * The transaction's line-item proof (receipts design S1): a snapped
 * photo — downscaled on-device — or, later, a fetched store receipt
 * with items. Empty state offers the camera and the connections door.
 */
export function ReceiptSection({ tx }: Readonly<{ tx: SpaceTx }>) {
  const { t, lang } = useLang();
  const navigate = useNavigate();
  const receipt = useTxReceipt(tx.id);
  const ops = useReceiptOps();
  const fileRef = useRef<HTMLInputElement>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ocrState, setOcrState] = useState<'idle' | 'busy' | 'failed'>('idle');

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await ops.attachPhoto(tx, file);
    } finally {
      setBusy(false);
    }
  };

  // OCR via the NAS sidecar (signed-in users only — demo stays offline)
  const readItems = async () => {
    if (!receipt?.image) return;
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
      await ops.setItems(receipt.id, items);
      setOcrState('idle');
    } catch {
      setOcrState('failed');
    }
  };

  const removeReceipt = async () => {
    if (!receipt) return;
    if (!confirmDelete) {
      setConfirmDelete(true);
      return;
    }
    await ops.remove(receipt.id);
    setConfirmDelete(false);
    setViewOpen(false);
  };

  if (receipt === undefined) return null;

  return (
    <>
      <div className="m-cap mt-5 mb-1 px-1">{t('receipt.title')}</div>
      {receipt === null ? (
        <div className="flex items-center gap-2 rounded-card border border-dashed border-line bg-surface px-4 py-3" data-testid="receipt-empty">
          <input
            ref={fileRef}
            data-testid="receipt-file"
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => void onFile(e.target.files?.[0])}
          />
          <Button size="sm" data-testid="receipt-take-photo" disabled={busy} onClick={() => fileRef.current?.click()}>
            <Icon name="camera-outline" size={16} />
            {t('receipt.takePhoto')}
          </Button>
          <button
            data-testid="receipt-connections"
            onClick={() => void navigate({ to: '/shopping' })}
            className="m-tap border-none bg-transparent text-[12px] font-medium text-accent-deep"
          >
            {t('shop.title')}
          </button>
        </div>
      ) : (
        <button
          data-testid="receipt-card"
          onClick={() => setViewOpen(true)}
          className="m-tap w-full overflow-hidden rounded-card border border-line bg-surface p-0 text-left"
        >
          {receipt.image && <img src={receipt.image} alt={t('receipt.title')} className="max-h-40 w-full object-cover" />}
          <span className="flex items-center gap-2 px-4 py-2.5">
            <Icon name={receipt.source === 'photo' ? 'camera-outline' : 'storefront-outline'} size={15} color="var(--m-ink-3)" />
            <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">
              {receipt.items?.length ? `${receipt.items.length} · ${t('receipt.items')}` : t('receipt.sourcePhoto')}
            </span>
            <span className="m-num text-[12px] font-semibold text-ink">{fmtCents(receipt.totalCents, tx.currency, lang)}</span>
          </span>
        </button>
      )}

      {/* full view + delete */}
      <Sheet open={viewOpen} onOpenChange={(open) => !open && setViewOpen(false)} title={t('receipt.title')} size="tall">
        {receipt?.image && <img src={receipt.image} alt={t('receipt.title')} className="max-h-[50vh] w-full rounded-card object-contain" />}
        {!!receipt?.items?.length && (
          <div className="mt-2 rounded-card border border-line bg-surface px-4 py-1" data-testid="receipt-items">
            {receipt.items.map((item) => (
              <div key={`${item.name}-${item.totalCents}`} className="flex items-baseline gap-2 border-b border-line-2 py-2 text-[13px] last:border-0">
                <span className="min-w-0 flex-1 truncate text-ink">{item.name}</span>
                {item.qty !== undefined && <span className="text-[11px] text-ink-4">×{item.qty}</span>}
                <span className="m-num text-ink">{fmtCents(item.totalCents, tx.currency, lang)}</span>
              </div>
            ))}
          </div>
        )}
        {receipt?.source === 'photo' && !receipt.items?.length && storesAvailable() && (
          <>
            <Button variant="outline" className="mt-3 w-full" data-testid="receipt-read-items" disabled={ocrState === 'busy'} onClick={() => void readItems()}>
              {t('receipt.readItems')}
            </Button>
            {ocrState === 'failed' && (
              <p className="mt-1 text-center text-[12px] text-ink-4" data-testid="receipt-read-failed">
                {t('receipt.readFailed')}
              </p>
            )}
          </>
        )}
        <Button variant="danger" className="mt-3 w-full" data-testid="receipt-delete" onClick={() => void removeReceipt()}>
          {confirmDelete ? t('action.confirm') : t('action.delete')}
        </Button>
      </Sheet>
    </>
  );
}
