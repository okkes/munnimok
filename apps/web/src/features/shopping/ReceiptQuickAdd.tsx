import { useCallback, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useReceiptOps } from '@/application/receipts';
import { Sheet } from '@/ui/Sheet';
import { ReceiptCaptureRungs } from './ReceiptCapture';
import { markFreshPhoto } from './receiptAi';

/** a picture becomes one of the person's scans and its own screen opens; `refused` while their scans cannot be reached yet */
export function useScanKeeper({ replace = false, onKept }: { replace?: boolean; onKept?: () => void } = {}) {
  const navigate = useNavigate();
  const receiptOps = useReceiptOps();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  const keep = useCallback(
    async (file: File) => {
      setBusy(true);
      setRefused(false);
      try {
        const receiptId = await receiptOps.addOwnPhoto(file);
        if (!receiptId) {
          setRefused(true);
          return;
        }
        markFreshPhoto(receiptId);
        onKept?.();
        // from the app icon's shortcut the scan screen is not a place to come back to
        void navigate({ to: '/receipts/$receiptId', params: { receiptId }, replace });
      } finally {
        setBusy(false);
      }
    },
    [receiptOps, navigate, replace, onKept],
  );
  return { busy, refused, keep };
}

// #567: a receipt kept before its transaction exists joins the person's own scans (#648: the spaces they share their
// scans with list it); its amount is what the payment is recognised by when it arrives
export function ReceiptQuickAdd({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useLang();
  const { busy, refused, keep } = useScanKeeper({ onKept: () => onOpenChange(false) });

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('receipt.quick.title')} size="form">
      <div className="flex flex-col gap-3 pt-1" data-testid="receipt-quick-sheet">
        <p className="px-1 text-[13px] leading-snug text-ink-3">{t('receipt.quick.body')}</p>
        <ReceiptCaptureRungs testIdPrefix="receipt-quick" busy={busy} onFile={(file) => void keep(file)} />
        {refused && (
          <p className="px-1 text-[12px] leading-snug text-negative" data-testid="receipt-quick-refused">
            {t('receipt.quick.offline')}
          </p>
        )}
      </div>
    </Sheet>
  );
}
