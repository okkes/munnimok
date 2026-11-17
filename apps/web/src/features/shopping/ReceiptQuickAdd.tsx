import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { useReceiptOps } from '@/application/receipts';
import { Sheet } from '@/ui/Sheet';
import { ReceiptCaptureRungs } from './ReceiptCapture';

// #567: a receipt kept before its transaction exists joins the person's own receipts (every space lists it)
// its amount is what the payment is recognised by when it arrives
export function ReceiptQuickAdd({ open, onOpenChange }: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void }>) {
  const { t } = useLang();
  const navigate = useNavigate();
  const receiptOps = useReceiptOps();
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState(false);

  const keep = async (file: File) => {
    setBusy(true);
    setRefused(false);
    try {
      const receiptId = await receiptOps.addOwnPhoto(file);
      if (!receiptId) {
        setRefused(true);
        return;
      }
      onOpenChange(false);
      void navigate({ to: '/receipts/$receiptId', params: { receiptId } });
    } finally {
      setBusy(false);
    }
  };

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
