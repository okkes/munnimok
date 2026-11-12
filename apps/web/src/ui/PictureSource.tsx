import { useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import { isNativeApp, takeNativePhoto } from '@/lib/platform';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/**
 * Where a picture comes from in the phone apps (#522). The Camera plugin hands every picture over as a
 * JPEG, its library door included, so a see-through logo arrived on black. The library door is the file
 * input now — the file as it is — and only the camera goes through the plugin. In a browser there is
 * nothing to choose: the file input is the door.
 */
export function usePictureSource(onFile: (file: File) => void, openLibrary: () => void): { pick: () => void; sheet: ReactNode } {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const pick = () => {
    if (isNativeApp()) setOpen(true);
    else openLibrary();
  };
  const row = 'm-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left';
  const sheet = (
    <Sheet open={open} onOpenChange={setOpen} title={t('picture.sourceTitle')}>
      <div className="flex flex-col gap-2 pt-1" data-testid="picture-source">
        <button
          data-testid="picture-source-camera"
          className={row}
          onClick={() => {
            setOpen(false);
            // null: cancelled or refused — the door stays as it was
            void takeNativePhoto('CAMERA').then((file) => file && onFile(file));
          }}
        >
          <Icon name="camera-outline" size={20} color="var(--m-accent-deep)" />
          <span className="text-[14px] text-ink">{t('picture.take')}</span>
        </button>
        <button
          data-testid="picture-source-library"
          className={row}
          onClick={() => {
            // inside the tap: a file input opened later is no longer the person's own act and is refused
            openLibrary();
            setOpen(false);
          }}
        >
          <Icon name="image-outline" size={20} color="var(--m-accent-deep)" />
          <span className="min-w-0 flex-1">
            <span className="block text-[14px] text-ink">{t('picture.choose')}</span>
            <span className="block text-[11px] text-ink-4">{t('picture.chooseSub')}</span>
          </span>
        </button>
      </div>
    </Sheet>
  );
  return { pick, sheet };
}
