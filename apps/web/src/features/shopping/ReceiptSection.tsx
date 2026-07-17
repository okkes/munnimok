import { useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useLgViewport } from '@/lib/viewport';
import { useReceiptOps, useTxReceipt } from '@/application/receipts';
import type { SpaceTx } from '@/db/joined';
import { fmtCents } from '@/lib/money';
import { isNativeApp, takeNativePhoto } from '@/lib/platform';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { ReceiptViewSheet } from './ReceiptViewSheet';

/**
 * The transaction's line-item proof (receipts design): a snapped photo
 * — downscaled on-device — or a fetched store receipt with items. The
 * empty state offers the camera and the connections door.
 */
export function ReceiptSection({ tx }: Readonly<{ tx: SpaceTx }>) {
  const { t, lang } = useLang();
  const panes = useLgViewport();
  const navigate = useNavigate();
  const receipt = useTxReceipt(tx.id);
  const ops = useReceiptOps();
  const fileRef = useRef<HTMLInputElement>(null);
  const [viewOpen, setViewOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      await ops.attachPhoto(tx, file);
    } finally {
      setBusy(false);
    }
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
          <Button
            size="sm"
            data-testid="receipt-take-photo"
            disabled={busy}
            onClick={() => {
              // shells use the Camera plugin: the webview <input capture>
              // path crashed on iOS and offered gallery-only on Android
              if (isNativeApp()) void takeNativePhoto().then((file) => onFile(file ?? undefined));
              else fileRef.current?.click();
            }}
          >
            <Icon name={panes ? 'upload-outline' : 'camera-outline'} size={16} />
            {panes ? t('receipt.upload') : t('receipt.takePhoto')}
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

      <ReceiptViewSheet receipt={viewOpen ? receipt : null} currency={tx.currency} onClose={() => setViewOpen(false)} contextTxId={tx.id} />
    </>
  );
}
