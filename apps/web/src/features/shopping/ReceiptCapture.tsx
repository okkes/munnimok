import { useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { isNativeApp, takeNativePhoto } from '@/lib/platform';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { WebcamCaptureSheet, useWebcamDoor } from '@/ui/WebcamCaptureSheet';

/** a phone (or the native shell) opens its own camera for "take a photo"; a desktop has the webcam rung instead */
const touchFirst = (): boolean => isNativeApp() || (typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches);

/**
 * The picker's ways to add a receipt of one's own, under its suggestions —
 * on the transaction detail, the review card (#542) and the bulk walk
 * alike: take a photo and upload a picture on a phone (#496: the upload was
 * desktop-only), upload and the webcam (#160) on a desktop, and the
 * connections door where the host can afford to leave.
 */
export function ReceiptCaptureRungs({
  testIdPrefix,
  busy,
  onFile,
  onConnections,
}: Readonly<{
  /** `receipt` on the detail (`receipt-file`, `receipt-take-photo`, …), the host's own prefix elsewhere */
  testIdPrefix: string;
  busy: boolean;
  onFile: (file: File) => void;
  /** the stores door — absent where leaving would drop a flow (the review, the bulk walk) */
  onConnections?: () => void;
}>) {
  const { t } = useLang();
  const webcam = useWebcamDoor();
  const [webcamOpen, setWebcamOpen] = useState(false);
  const cameraRef = useRef<HTMLInputElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const id = (suffix: string): string => `${testIdPrefix}-${suffix}`;
  const phone = touchFirst();
  // the shells use the Camera plugin: the webview <input capture> path crashed on iOS and offered gallery-only on Android
  const viaNative = (source: 'CAMERA' | 'PHOTOS') => void takeNativePhoto(source).then((file) => file && onFile(file));
  const take = () => (isNativeApp() ? viaNative('CAMERA') : cameraRef.current?.click());
  const upload = () => (isNativeApp() ? viaNative('PHOTOS') : uploadRef.current?.click());
  const picked = (input: HTMLInputElement) => {
    const file = input.files?.[0];
    input.value = ''; // the same picture twice still reports a change
    if (file) onFile(file);
  };
  return (
    <>
      <input ref={cameraRef} data-testid={id('file')} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => picked(e.currentTarget)} />
      <input ref={uploadRef} data-testid={id('upload-file')} type="file" accept="image/*" className="hidden" onChange={(e) => picked(e.currentTarget)} />
      <div className="flex gap-2">
        {phone && (
          <Button variant="outline" className="min-w-0 flex-1" data-testid={id('take-photo')} disabled={busy} onClick={take}>
            <Icon name="camera-outline" size={16} />
            {t('receipt.takePhoto')}
          </Button>
        )}
        <Button variant="outline" className="min-w-0 flex-1" data-testid={id('upload')} disabled={busy} onClick={upload}>
          <Icon name="upload-outline" size={16} />
          {t('receipt.upload')}
        </Button>
        {/* #160: a desktop's webcam snapshot — the same attach path as a file */}
        {!phone && webcam && (
          <Button variant="outline" className="min-w-0 flex-1" data-testid={id('webcam')} disabled={busy} onClick={() => setWebcamOpen(true)}>
            <Icon name="camera-outline" size={16} />
            {t('webcam.use')}
          </Button>
        )}
      </div>
      {onConnections && (
        <button
          data-testid={id('connections')}
          onClick={onConnections}
          className="m-tap border-none bg-transparent py-1 text-center text-[12px] font-medium text-accent-deep"
        >
          {t('conn.title')}
        </button>
      )}
      <WebcamCaptureSheet open={webcamOpen} onOpenChange={setWebcamOpen} onCapture={onFile} />
    </>
  );
}
