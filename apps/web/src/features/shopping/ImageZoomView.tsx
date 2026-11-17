import { useState } from 'react';
import { useLang } from '@/i18n';
import { ZoomFrame } from './ZoomFrame';

const touchFirst = (): boolean => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)')?.matches;

/** #568: a receipt photo or image invoice must zoom, so single items are readable */
export function ImageZoomView({ src, alt, testId }: Readonly<{ src: string; alt: string; testId: string }>) {
  const { t } = useLang();
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
