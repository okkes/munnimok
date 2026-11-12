import { useEffect, useMemo, useRef, useState } from 'react';
import { useLang } from '@/i18n';
import { readSessionIdentity } from '@/app/session';
import { apiFetch, getApiCapabilities } from '@/lib/api';
import { downscaleImage } from '@/lib/image';
import { usePictureSource } from '@/ui/PictureSource';
import { Highlight } from '@/ui/Highlight';
import { Icon } from '@/ui/Icon';
import { IconPicker } from '@/ui/IconPicker';
import { Picture } from '@/ui/Picture';
import { SearchField } from '@/ui/SearchField';
import { Sheet } from '@/ui/Sheet';
import { WebcamCaptureSheet, useWebcamDoor } from '@/ui/WebcamCaptureSheet';

/**
 * Brand logo picker for recurring costs, accounts, … Two labelled
 * segments: the vendored simpleicons set leads (public/brands —
 * precached, instant, works fully offline and for demo/offline
 * identities) and, when the server has logo.dev configured and the
 * identity may use the network, an online section follows with far
 * wider coverage. Local hits never disappear when the online answer
 * lands (user bug: they used to be deduped away).
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
  /** #520: an icon picked from the font — the host's own face, the logo cleared with it */
  icon?: string;
}

/** #520: a host whose face can be an icon of its own (a recurring cost) offers the icon font beside the logos */
export interface IconChoice {
  /** the icon the host shows when no logo is set */
  value: string;
  /** its suggestions, shown first */
  featured: readonly string[];
  /** the face now: a logo, the host's default icon, or an icon picked before (the sheet then opens on the icons) */
  face: 'logo' | 'default' | 'own';
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
  /** #520: offer the whole icon font as well — an Icon | Logo switch heads the sheet */
  icons?: IconChoice;
}

export function BrandIconPicker({ open, onOpenChange, onPick, initialQuery = '', icons }: Readonly<BrandIconPickerProps>) {
  const { t } = useLang();
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<'icon' | 'logo'>('logo');
  const [iconQuery, setIconQuery] = useState('');
  useEffect(() => {
    if (!open) return;
    setTab(icons?.face === 'own' ? 'icon' : 'logo');
    setIconQuery('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const prefilled = useRef(false);
  const uploadRef = useRef<HTMLInputElement>(null);
  // #160: desktop-only webcam door under the upload row
  const webcamDoor = useWebcamDoor();
  const [webcamOpen, setWebcamOpen] = useState(false);

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
    if (!open || tab !== 'logo' || q.length < 2 || readSessionIdentity()?.kind !== 'user') {
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
  }, [open, query, tab]);

  const remoteShown = remote.slice(0, 12);

  const localShown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hits = q ? index.filter((b) => b.title.toLowerCase().includes(q) || b.slug.includes(q)) : index;
    return hits.slice(0, 24);
  }, [index, query]);

  const pick = (logo: string | null) => {
    onPick({ logo });
    setQuery('');
    onOpenChange(false);
  };
  const pickIcon = (name: string) => {
    onPick({ logo: null, icon: name });
    setQuery('');
    onOpenChange(false);
  };

  // one downscale path for all three photo doors (input, native, webcam):
  // undecodable files (HEIC on desktop…) reject — swallow like the
  // sibling upload sites; the picker simply stays open
  const applyPhoto = (file: File): void => {
    void downscaleImage(file, 256, 0.85)
      .then((dataUrl) => pick(dataUrl))
      .catch(() => undefined);
  };

  // #521: the web search starts from what the sheet is looking for — "<name> logo"
  const searchWords = (query || initialQuery).trim();
  const { pick: pickPhoto, sheet: pictureSheet } = usePictureSource(applyPhoto, () => uploadRef.current?.click(), searchWords ? `${searchWords} logo` : '');

  return (
    <>
    {/* #344: steady — search results and conditional sections toggle per
        keystroke, and the growing dialog pumped between sizes */}
    <Sheet open={open} onOpenChange={onOpenChange} title={t(icons ? 'recurring.faceTitle' : 'recurring.iconTitle')} size="tall" steady dragHandle>
      <div className="flex flex-col gap-3 pt-1">
        {icons && (
          <div className="flex rounded-xl bg-bg-2 p-0.5" role="tablist" data-testid="brandpicker-tabs">
            {(['icon', 'logo'] as const).map((which) => (
              <button
                key={which}
                type="button"
                role="tab"
                aria-selected={tab === which}
                data-testid={`brandpicker-tab-${which}`}
                onClick={() => setTab(which)}
                className={`m-tap flex-1 rounded-[10px] border-none px-2.5 py-2 text-[13px] ${
                  tab === which ? 'bg-surface font-semibold text-ink shadow-sm' : 'bg-transparent text-ink-3'
                }`}
              >
                {t(which === 'icon' ? 'recurring.faceIcon' : 'recurring.faceLogo')}
              </button>
            ))}
          </div>
        )}
        {/* #520 (user): the whole icon font, the custom categories' picker — no ring while a logo is the face */}
        {icons && tab === 'icon' ? (
          <IconPicker
            value={icons.value}
            onChange={pickIcon}
            featured={icons.featured}
            query={iconQuery}
            onQuery={setIconQuery}
            testIdPrefix="brandpicker-icon"
            sleeping={icons.face === 'logo'}
          />
        ) : (
        <>
        {/* the field arrives prefilled with the cost's name — #234: the
            shared SearchField (this picker's pattern, generalized) */}
        <SearchField
          testId="brandpicker-search"
          value={query}
          onFocus={onSearchFocus}
          onChange={(next) => {
            if (next === '') prefilled.current = false;
            setQuery(next);
          }}
          placeholder={t('recurring.iconSearch')}
          textSize="text-[14px]"
        />
        {/* with an icon tab, the way back from a logo is picking an icon there */}
        {!icons && (
          <button
            data-testid="brandpicker-none"
            onClick={() => pick(null)}
            className="m-tap flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-left text-[13px] text-ink-2"
          >
            <Icon name="autorenew" size={18} color="var(--m-ink-3)" />
            {t('recurring.iconNone')}
          </button>
        )}
        {/* own image (user request 2026-08-01): third source beside the
            vendored set and logo.dev — downscaled like event pictures so
            it syncs as a field */}
        <button
          data-testid="brandpicker-upload"
          onClick={pickPhoto}
          className="m-tap flex items-center gap-3 rounded-card border border-dashed border-line bg-surface px-4 py-2.5 text-left text-[13px] text-ink-2"
        >
          <Icon name="image-plus-outline" size={18} color="var(--m-accent)" />
          {t('recurring.iconUpload')}
        </button>
        {/* #160: desktop webcam snapshot — same downscale as the upload */}
        {webcamDoor && (
          <button
            data-testid="brandpicker-webcam"
            onClick={() => setWebcamOpen(true)}
            className="m-tap flex items-center gap-3 rounded-card border border-dashed border-line bg-surface px-4 py-2.5 text-left text-[13px] text-ink-2"
          >
            <Icon name="camera-outline" size={18} color="var(--m-accent)" />
            {t('webcam.use')}
          </button>
        )}
        {pictureSheet}
        <input
          ref={uploadRef}
          data-testid="brandpicker-upload-input"
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) applyPhoto(file);
          }}
        />

        {remoteState === 'unavailable' && (
          <p className="px-1 text-[12px] text-ink-3" data-testid="brandpicker-offline-note">
            {t('recurring.iconOfflineNote')}
          </p>
        )}

        {/* the vendored set leads and never disappears; captions only when
            both segments are on screen, so the plain browse view stays calm */}
        {remoteShown.length > 0 && localShown.length > 0 && (
          <div className="m-cap px-1">{t('recurring.iconBuiltin')}</div>
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
              <Picture src={`brands/${brand.slug}.svg`} className="h-7 w-7 rounded object-contain" loading="lazy" />
              <span className="w-full truncate text-center text-[10px] text-ink-3">
                <Highlight text={brand.title} query={query} />
              </span>
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
                  <Picture src={r.logoUrl} className="h-7 w-7 rounded object-contain" loading="lazy" />
                  <span className="w-full truncate text-center text-[10px] text-ink-3">
                    <Highlight text={r.name} query={query} />
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
        </>
        )}
      </div>
    </Sheet>
    {/* #160: snapshot feeds the same downscale-then-pick path */}
    <WebcamCaptureSheet open={webcamOpen} onOpenChange={setWebcamOpen} onCapture={applyPhoto} />
    </>
  );
}
