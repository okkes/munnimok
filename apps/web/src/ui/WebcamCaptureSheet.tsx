import { useEffect, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { useLgViewport } from '@/lib/viewport';
import { Button } from './Button';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/** #160: the webcam door shows only where it earns its place — desktop
 *  viewports (phones/native have the camera path already) whose browser
 *  actually exposes a mediaDevices camera API */
export function useWebcamDoor(): boolean {
  const panes = useLgViewport();
  return panes && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

interface WebcamCaptureSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** the snapshot, ready for the host's existing downscale/attach path */
  onCapture: (file: File) => void;
}

/**
 * #160 (user): desktops have no camera-capable file input worth using —
 * a webcam snapshot sheet serves every own-picture upload site instead.
 * The stream starts on open and every track stops on close/unmount so
 * the camera light never lingers. Errors (permission denied, no camera,
 * no mediaDevices at all — happy-dom) render a note, never a crash.
 */
export function WebcamCaptureSheet({ open, onOpenChange, onCapture }: Readonly<WebcamCaptureSheetProps>) {
  const { t } = useLang();
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(false);
    let cancelled = false;
    const media = navigator.mediaDevices;
    if (!media?.getUserMedia) {
      setError(true); // no API at all (old browser, test env)
      return;
    }
    media
      .getUserMedia({ video: { facingMode: 'user' } })
      .then((stream) => {
        if (cancelled) {
          // closed before the permission prompt resolved
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          try {
            video.srcObject = stream;
          } catch {
            // happy-dom's <video> lacks a real srcObject sink — the
            // preview simply stays blank there
          }
        }
      })
      .catch(() => setError(true)); // permission denied / no camera
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    };
  }, [open]);

  const capture = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(
      (blob) => {
        // defensive: environments without canvas pixels (happy-dom)
        // yield null — keep the sheet open instead of faking a photo
        if (!blob) return;
        onCapture(new File([blob], 'webcam.jpg', { type: 'image/jpeg' }));
        onOpenChange(false);
      },
      'image/jpeg',
      0.85,
    );
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('webcam.title')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        {error ? (
          <p className="rounded-card bg-bg-2 px-4 py-3 text-[13px] text-ink-3" data-testid="webcam-error">
            {t('webcam.error')}
          </p>
        ) : (
          <>
            {/* fixed px height — sheets must never size off vh */}
            <video
              ref={videoRef}
              data-testid="webcam-video"
              autoPlay
              playsInline
              muted
              className="h-[320px] w-full rounded-card bg-bg-2 object-cover"
            />
            <Button data-testid="webcam-capture" onClick={capture}>
              <Icon name="camera-outline" size={16} />
              {t('webcam.capture')}
            </Button>
          </>
        )}
      </div>
    </Sheet>
  );
}
