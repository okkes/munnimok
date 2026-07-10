import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { readSessionIdentity } from '@/app/session';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { Highlight } from '@/ui/Highlight';
import { Icon } from '@/ui/Icon';
import { Sheet } from '@/ui/Sheet';

/**
 * Brand logo picker for recurring costs. Two sources, seamlessly merged:
 * the vendored simpleicons set (public/brands — precached, so it works
 * fully offline and for demo/offline identities) and, when the server
 * has logo.dev configured and the identity may use the network, live
 * brand search with far wider coverage.
 */

interface BrandEntry {
  slug: string;
  title: string;
}

interface RemoteLogo {
  name: string;
  domain: string;
  logoUrl: string;
}

export interface PickedLogo {
  /** '/brands/{slug}.svg' or a logo.dev image URL; null = default icon */
  logo: string | null;
}

let brandIndexCache: BrandEntry[] | null = null;
async function loadBrandIndex(): Promise<BrandEntry[]> {
  if (brandIndexCache) return brandIndexCache;
  try {
    const res = await fetch('brands/index.json');
    brandIndexCache = res.ok ? ((await res.json()) as BrandEntry[]) : [];
  } catch {
    brandIndexCache = [];
  }
  return brandIndexCache;
}

/** logo.dev search via the API proxy; null when unavailable (offline/unconfigured) */
async function searchRemoteLogos(q: string): Promise<RemoteLogo[] | null> {
  if (!(await getApiCapabilities()).logos) return null;
  const res = await apiFetch(`/logos/search?q=${encodeURIComponent(q)}`).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as RemoteLogo[];
}

interface BrandIconPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPick: (picked: PickedLogo) => void;
  /** prefill (e.g. the cost's name); the first tap on the field clears it */
  initialQuery?: string;
}

export function BrandIconPicker({ open, onOpenChange, onPick, initialQuery = '' }: Readonly<BrandIconPickerProps>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const prefilled = useRef(false);

  // search starts from the name the user already typed — usually exactly
  // the brand they want; one tap on the field starts a fresh query
  useEffect(() => {
    if (!open) return;
    setQuery(initialQuery.trim());
    prefilled.current = initialQuery.trim().length > 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const onSearchFocus = () => {
    if (!prefilled.current) return;
    prefilled.current = false;
    setQuery('');
  };
  const [index, setIndex] = useState<BrandEntry[]>([]);
  const [remote, setRemote] = useState<RemoteLogo[]>([]);
  // 'unavailable' = offline or server not configured — say so instead of
  // silently showing only the vendored set (looked like a broken search)
  const [remoteState, setRemoteState] = useState<'idle' | 'searching' | 'ok' | 'unavailable'>('idle');
  const searchSeq = useRef(0);

  useEffect(() => {
    if (open) void loadBrandIndex().then(setIndex);
  }, [open]);

  // live logo.dev search, debounced — the primary source when it answers.
  // Local-only identities skip it entirely (their choice, not an outage,
  // so no 'unavailable' note either).
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2 || readSessionIdentity()?.kind !== 'user') {
      setRemote([]);
      setRemoteState('idle');
      return;
    }
    const seq = ++searchSeq.current;
    setRemoteState('searching');
    const timer = setTimeout(() => {
      void searchRemoteLogos(q).then((results) => {
        if (seq !== searchSeq.current) return;
        setRemote(results ?? []);
        setRemoteState(results === null ? 'unavailable' : 'ok');
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [open, query]);

  const remoteShown = remote.slice(0, 12);

  const local = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? index.filter((b) => b.title.toLowerCase().includes(q) || b.slug.includes(q)) : index;
    return hits.slice(0, 24);
  }, [index, query]);

  // when the online search answered, drop vendored duplicates of its hits
  const remoteSlugs = useMemo(() => new Set(remoteShown.map((r) => r.domain.split('.')[0])), [remoteShown]);
  const localShown = remoteShown.length > 0 ? local.filter((b) => !remoteSlugs.has(b.slug)) : local;

  const pick = (logo: string | null) => {
    onPick({ logo });
    setQuery('');
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('recurring.iconTitle')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        {/* the field arrives prefilled with the cost's name — the search
            glyph and the ✕ make it read as an editable search box */}
        <div className="relative">
          <span className="pointer-events-none absolute top-0 left-3 flex h-11 items-center">
            <Icon name="magnify" size={17} color="var(--m-ink-4)" />
          </span>
          <input
            data-testid="brandpicker-search"
            value={query}
            onFocus={onSearchFocus}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('recurring.iconSearch')}
            className="h-11 w-full rounded-input border border-line bg-surface pr-10 pl-10 text-[14px] text-ink outline-none placeholder:text-ink-4"
          />
          {query.length > 0 && (
            <button
              aria-label={t('action.dismiss')}
              data-testid="brandpicker-clear"
              onClick={() => {
                prefilled.current = false;
                setQuery('');
              }}
              className="m-tap absolute top-0 right-1 flex h-11 w-9 items-center justify-center border-none bg-transparent"
            >
              <Icon name="close-circle" size={16} color="var(--m-ink-4)" />
            </button>
          )}
        </div>
        <button
          data-testid="brandpicker-none"
          onClick={() => pick(null)}
          className="m-tap flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-left text-[13px] text-ink-2"
        >
          <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
          {t('recurring.iconNone')}
        </button>

        {remoteState === 'unavailable' && (
          <p className="px-1 text-[12px] text-ink-3" data-testid="brandpicker-offline-note">
            {t('recurring.iconOfflineNote')}
          </p>
        )}

        {/* online results lead: wider coverage and real brand marks */}
        {remoteShown.length > 0 && (
          <>
            <div className="m-cap px-1">{t('recurring.iconOnline')}</div>
            <div className="grid grid-cols-4 gap-2" data-testid="brandpicker-remote">
              {remoteShown.map((r) => (
                <button
                  key={r.domain}
                  data-testid={`brandpicker-remote-${r.domain}`}
                  title={r.name}
                  onClick={() => pick(r.logoUrl)}
                  className="m-tap flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface px-1 py-2.5"
                >
                  <img src={r.logoUrl} alt="" className="h-7 w-7 rounded object-contain" loading="lazy" />
                  <span className="w-full truncate text-center text-[10px] text-ink-3">
                    <Highlight text={r.name} query={query} />
                  </span>
                </button>
              ))}
            </div>
            {localShown.length > 0 && <div className="m-cap px-1">{t('recurring.iconBuiltin')}</div>}
          </>
        )}

        <div className="grid grid-cols-4 gap-2" data-testid="brandpicker-local">
          {localShown.map((brand) => (
            <button
              key={brand.slug}
              data-testid={`brandpicker-${brand.slug}`}
              title={brand.title}
              onClick={() => pick(`brands/${brand.slug}.svg`)}
              className="m-tap flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface px-1 py-2.5"
            >
              <img src={`brands/${brand.slug}.svg`} alt="" className="h-7 w-7 object-contain" loading="lazy" />
              <span className="w-full truncate text-center text-[10px] text-ink-3">
                <Highlight text={brand.title} query={query} />
              </span>
            </button>
          ))}
        </div>
      </div>
    </Sheet>
  );
}
