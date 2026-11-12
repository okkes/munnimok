import { useEffect, useState } from 'react';
import { LOCALES, useLang } from '@/i18n';
import { Button } from '@/ui/Button';
import { Icon } from '@/ui/Icon';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { fetchPickedImage, googleImagesUrl, searchImages } from './imageSearch';
import type { ImageHit, ImageSearchReply } from './imageSearch';

/** the note in place of results when the search has none to give: why, until when, and the way out */
function StateNote({ reply, query }: Readonly<{ reply: ImageSearchReply; query: string }>) {
  const { t, lang } = useLang();
  const when = reply.until
    ? new Date(reply.until).toLocaleString(LOCALES[lang], { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
    : '';
  const text = {
    ok: t('picture.search.empty'),
    paused: t('picture.search.paused', { when }),
    limited: t('picture.search.limited', { when }),
    unavailable: t('picture.search.unavailable'),
  }[reply.state];
  return (
    <div className="rounded-card bg-bg-2 p-3 text-[12px] leading-snug text-ink-2" data-testid="imagesearch-note" data-state={reply.state}>
      <p>{text}</p>
      {reply.state !== 'ok' && (
        // user 2026-11-11: a way out while the search is paused — the picture then comes in as a file
        <a
          href={googleImagesUrl(query)}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="imagesearch-google"
          className="mt-2 inline-flex items-center gap-1 font-semibold text-accent-deep"
        >
          {t('picture.search.google')}
          <Icon name="open-in-new" size={13} />
        </a>
      )}
      {reply.state !== 'ok' && <p className="mt-1 text-[11px] text-ink-4">{t('picture.search.googleHint')}</p>}
    </div>
  );
}

/**
 * #521 (user): "google search pictures … then the user can just pick one
 * they like (or they can search for something else)". Every search is paid
 * for, so it runs on the button, never while typing; the words start from
 * what the picture is for. A picked picture goes to the caller as a file —
 * the same road an upload takes.
 */
export function ImageSearchSheet({
  open,
  onOpenChange,
  initialQuery = '',
  onPick,
}: Readonly<{ open: boolean; onOpenChange: (open: boolean) => void; initialQuery?: string; onPick: (file: File) => void }>) {
  const { t } = useLang();
  const [query, setQuery] = useState(initialQuery);
  const [searched, setSearched] = useState('');
  const [reply, setReply] = useState<ImageSearchReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<string | null>(null);
  const [pickFailed, setPickFailed] = useState(false);

  // every opening starts from what the picture is for, with nothing found yet
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery);
    setSearched('');
    setReply(null);
    setPickFailed(false);
  }, [open, initialQuery]);

  const words = query.trim();
  const canSearch = words.length >= 2 && !busy;

  const search = async () => {
    if (!canSearch) return;
    setBusy(true);
    setPickFailed(false);
    try {
      setReply(await searchImages(words));
      setSearched(words);
    } finally {
      setBusy(false);
    }
  };

  const pick = async (hit: ImageHit) => {
    if (picking) return;
    setPicking(hit.thumbnail);
    setPickFailed(false);
    try {
      const file = await fetchPickedImage(hit);
      if (!file) {
        setPickFailed(true);
        return;
      }
      onPick(file);
      onOpenChange(false);
    } finally {
      setPicking(null);
    }
  };

  const hits = reply?.state === 'ok' ? reply.results : [];

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('picture.search.title')} size="tall">
      <div className="flex flex-col gap-3 pt-1" data-testid="imagesearch">
        <form
          className="flex items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void search();
          }}
        >
          <SearchField testId="imagesearch-query" value={query} onChange={setQuery} placeholder={t('picture.search.placeholder')} className="min-w-0 flex-1" />
          <Button type="submit" data-testid="imagesearch-go" disabled={!canSearch}>
            {t('picture.search.go')}
          </Button>
        </form>
        {busy && (
          <p className="px-1 text-[12px] text-ink-4" data-testid="imagesearch-busy">
            {t('picture.search.busy')}
          </p>
        )}
        {reply && !busy && hits.length === 0 && <StateNote reply={reply} query={searched} />}
        {pickFailed && (
          <p className="px-1 text-[12px] text-negative" data-testid="imagesearch-pickfailed">
            {t('picture.search.pickFailed')}
          </p>
        )}
        {hits.length > 0 && (
          <>
            <div className="grid grid-cols-3 gap-2" data-testid="imagesearch-results">
              {hits.map((hit, index) => (
                <button
                  key={hit.thumbnail}
                  type="button"
                  data-testid={`imagesearch-hit-${index}`}
                  aria-label={hit.title || hit.source}
                  aria-busy={picking === hit.thumbnail}
                  disabled={picking !== null}
                  onClick={() => void pick(hit)}
                  className={`m-tap relative aspect-square overflow-hidden rounded-card border border-line bg-surface p-1 ${picking === hit.thumbnail ? 'opacity-50' : ''}`}
                >
                  <img src={hit.thumbnail} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-full w-full object-contain" />
                </button>
              ))}
            </div>
            <p className="px-1 text-[11px] text-ink-4" data-testid="imagesearch-credit">
              {t('picture.search.credit')}
            </p>
          </>
        )}
      </div>
    </Sheet>
  );
}
