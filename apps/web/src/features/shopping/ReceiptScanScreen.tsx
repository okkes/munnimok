import { useEffect, useRef } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useLang } from '@/i18n';
import { isNativeApp, takeNativePhoto } from '@/lib/platform';
import { AppBar, IconButton } from '@/ui/AppBar';
import { Icon } from '@/ui/Icon';
import { ReceiptCaptureRungs } from './ReceiptCapture';
import { useScanKeeper } from './ReceiptQuickAdd';

// #648: where the app icon's "Scan a receipt" lands (munni://scan, the installed web app's shortcut): the camera at
// once where the shell can open it; a browser opens no camera without a tap, so there it is one tap away
export function ReceiptScanScreen() {
  const { t } = useLang();
  const navigate = useNavigate();
  const { busy, refused, keep } = useScanKeeper({ replace: true });
  const opened = useRef(false);

  useEffect(() => {
    if (opened.current || !isNativeApp()) return;
    opened.current = true;
    void takeNativePhoto('CAMERA').then((file) => file && keep(file));
  }, [keep]);

  // opened from the icon there is nothing to go back to
  const back = () => (window.history.length > 1 ? window.history.back() : void navigate({ to: '/' }));

  return (
    <div className="m-fade flex h-full flex-col" data-testid="screen-receipt-scan">
      <AppBar
        title={t('receipt.scan.title')}
        leading={
          <IconButton label={t('action.back')} testId="receipt-scan-back" onClick={back}>
            <Icon name="arrow-left" size={22} />
          </IconButton>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pb-16 text-center">
        <Icon name="receipt-text-outline" size={44} color="var(--m-ink-4)" />
        <p className="max-w-sm text-[13px] leading-snug text-ink-3">{t('receipt.scan.body')}</p>
        <div className="flex w-full max-w-sm flex-col gap-3">
          <ReceiptCaptureRungs testIdPrefix="receipt-scan" busy={busy} onFile={(file) => void keep(file)} />
        </div>
        {refused && (
          <p className="max-w-sm text-[12px] leading-snug text-negative" data-testid="receipt-scan-refused">
            {t('receipt.quick.offline')}
          </p>
        )}
      </div>
    </div>
  );
}
