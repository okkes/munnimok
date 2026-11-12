import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import { ImageSearchSheet } from '@/features/pictures/ImageSearchSheet';
import { getApiCapabilities } from '@/lib/api';
import { isNativeApp, takeNativePhoto } from '@/lib/platform';
import { Icon } from './Icon';
import { Sheet } from './Sheet';

/** does this environment search the web for pictures? Offline and demo profiles never ask and never do */
function useWebSearch(): boolean {
  const [on, setOn] = useState(false);
  useEffect(() => {
    let alive = true;
    void getApiCapabilities().then((caps) => {
      if (alive) setOn(caps.imageSearch === true);
    });
    return () => {
      alive = false;
    };
  }, []);
  return on;
}

/**
 * Where a picture comes from. In the phone apps (#522) the Camera plugin hands every picture over as a
 * JPEG, its library door included, so a see-through logo arrived on black: the library door is the file
 * input now — the file as it is — and only the camera goes through the plugin. Where the environment
 * searches the web (#521, user 2026-11-11: "wherever we can upload pictures") that is a third door, in
 * a browser too; `searchHint` is what the picture is for, the words the search starts from. With
 * nothing to choose between — a browser without web search — the file input is the door.
 */
export function usePictureSource(onFile: (file: File) => void, openLibrary: () => void, searchHint = ''): { pick: () => void; sheet: ReactNode } {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const webSearch = useWebSearch();
  const native = isNativeApp();
  const pick = () => {
    if (native || webSearch) setOpen(true);
    else openLibrary();
  };
  const row = 'm-tap flex w-full items-center gap-3 rounded-card border border-line bg-surface px-4 py-3 text-left';
  const sheet = (
    <>
      <Sheet open={open} onOpenChange={setOpen} title={t('picture.sourceTitle')}>
        <div className="flex flex-col gap-2 pt-1" data-testid="picture-source">
          {native && (
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
          )}
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
          {webSearch && (
            <button
              data-testid="picture-source-search"
              className={row}
              onClick={() => {
                setOpen(false);
                setSearching(true);
              }}
            >
              <Icon name="image-search-outline" size={20} color="var(--m-accent-deep)" />
              <span className="min-w-0 flex-1">
                <span className="block text-[14px] text-ink">{t('picture.searchWeb')}</span>
                <span className="block text-[11px] text-ink-4">{t('picture.searchWebSub')}</span>
              </span>
            </button>
          )}
        </div>
      </Sheet>
      {webSearch && <ImageSearchSheet open={searching} onOpenChange={setSearching} initialQuery={searchHint} onPick={onFile} />}
    </>
  );
  return { pick, sheet };
}
