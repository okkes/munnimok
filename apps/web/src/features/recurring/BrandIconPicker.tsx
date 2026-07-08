import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { apiFetch, getApiCapabilities } from '@/lib/api';
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
}

export function BrandIconPicker({ open, onOpenChange, onPick }: Readonly<BrandIconPickerProps>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState<BrandEntry[]>([]);
  const [remote, setRemote] = useState<RemoteLogo[]>([]);
  const searchSeq = useRef(0);

  useEffect(() => {
    if (open) void loadBrandIndex().then(setIndex);
  }, [open]);

  // live logo.dev search, debounced; silently absent offline/unconfigured
  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2) {
      setRemote([]);
      return;
    }
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void searchRemoteLogos(q).then((results) => {
        if (results && seq === searchSeq.current) setRemote(results);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [open, query]);

  const local = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? index.filter((b) => b.title.toLowerCase().includes(q) || b.slug.includes(q)) : index;
    return hits.slice(0, 24);
  }, [index, query]);

  // remote results the vendored set already covers are noise
  const localSlugs = useMemo(() => new Set(local.map((b) => b.slug)), [local]);
  const remoteShown = remote.filter((r) => !localSlugs.has(r.domain.split('.')[0])).slice(0, 12);

  const pick = (logo: string | null) => {
    onPick({ logo });
    setQuery('');
    onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange} title={t('recurring.iconTitle')} size="tall">
      <div className="flex flex-col gap-3 pt-1">
        <input
          data-testid="brandpicker-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('recurring.iconSearch')}
          className="h-11 w-full rounded-input border border-line bg-surface px-4 text-[14px] text-ink outline-none placeholder:text-ink-4"
        />
        <button
          data-testid="brandpicker-none"
          onClick={() => pick(null)}
          className="m-tap flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-left text-[13px] text-ink-2"
        >
          <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
          {t('recurring.iconNone')}
        </button>

        <div className="grid grid-cols-4 gap-2" data-testid="brandpicker-local">
          {local.map((brand) => (
            <button
              key={brand.slug}
              data-testid={`brandpicker-${brand.slug}`}
              title={brand.title}
              onClick={() => pick(`brands/${brand.slug}.svg`)}
              className="m-tap flex flex-col items-center gap-1.5 rounded-xl border border-line bg-surface px-1 py-2.5"
            >
              <img src={`brands/${brand.slug}.svg`} alt="" className="h-7 w-7 object-contain" loading="lazy" />
              <span className="w-full truncate text-center text-[10px] text-ink-3">{brand.title}</span>
            </button>
          ))}
        </div>

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
                  <span className="w-full truncate text-center text-[10px] text-ink-3">{r.name}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </Sheet>
  );
}
