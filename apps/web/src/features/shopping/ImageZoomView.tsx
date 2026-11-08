import { useState } from 'react';
import { useLang } from '@/i18n';
import { ZoomFrame } from './ZoomFrame';

/** a phone pinches and taps; a desktop double-clicks and scrolls with ctrl/⌘ (a trackpad pinch is the same) */
const touchFirst = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches;

/**
 * A picture at the frame's width with the zoom on top (#568: "once
 * uploading the picture of the receipt, I can't zoom in any more" — the
 * single items must be readable): the receipt's photo and an invoice that
 * came as an image, in the invoice viewer's frame.
 */
export function ImageZoomView({ src, alt, testId }: Readonly<{ src: string; alt: string; testId: string }>) {
  const { t } = useLang();
  // height over width, once the picture has loaded — the layout then follows the zoom at once
  const [ratio, setRatio] = useState<number | null>(null);
  return (
    <ZoomFrame testId={testId} status={t(touchFirst() ? 'receipt.zoomHintTouch' : 'receipt.zoomHintPointer')}>
      {(width) => (
        <img
          src={src}
          alt={alt}
          draggable={false}
          data-testid={`${testId}-img`}
          onLoad={(e) => {
            const img = e.currentTarget;
            if (img.naturalWidth > 0) setRatio(img.naturalHeight / img.naturalWidth);
          }}
          className="block max-w-none bg-white shadow-sm"
          style={width > 0 ? { width, height: ratio ? width * ratio : 'auto' } : { width: '100%' }}
        />
      )}
    </ZoomFrame>
  );
}
