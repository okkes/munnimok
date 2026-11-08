import { useEffect, useState, useSyncExternalStore } from 'react';

/** the backdrop a see-through picture is given */
export type Plate = 'light' | 'dark';
type Theme = 'light' | 'dark';

/** what a picture's pixels say — free of the theme, so one measurement serves both */
export interface PictureStats {
  /** a real part of it is see-through (a logo on nothing) — not just a rounded icon's corners */
  cutout: boolean;
  /** the share of its ink that stands out on a light ground, and on a dark one */
  onLight: number;
  onDark: number;
}

/** the long side a picture is measured at */
const SAMPLE_PX = 32;
/** see-through share from which a picture is a cut-out */
const CUTOUT_SHARE = 0.15;
/** the contrast a pixel needs against the ground to read */
const READS = 2;
/** the share of the ink that must read for the ground to need no plate */
const ENOUGH = 0.75;
/** the themes' grounds (bg, bg-2 and surface sit within a few points of these) */
const GROUND: Record<Theme, number> = { light: 0.88, dark: 0.013 };

const linear = (v: number) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** the stats of RGBA pixels (unpremultiplied, as a canvas hands them out) */
export function pictureStats(rgba: Uint8ClampedArray): PictureStats {
  const pixels = rgba.length / 4;
  let seeThrough = 0;
  let ink = 0;
  let light = 0;
  let dark = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    const alpha = rgba[i + 3] / 255;
    if (alpha < 0.5) seeThrough += 1;
    if (alpha < 0.1) continue;
    const l = luminance(rgba[i], rgba[i + 1], rgba[i + 2]);
    ink += alpha;
    if (contrast(l, GROUND.light) >= READS) light += alpha;
    if (contrast(l, GROUND.dark) >= READS) dark += alpha;
  }
  return {
    cutout: pixels > 0 && seeThrough / pixels >= CUTOUT_SHARE,
    onLight: ink > 0 ? light / ink : 1,
    onDark: ink > 0 ? dark / ink : 1,
  };
}

/** a plate only where the picture would vanish into the theme's ground — the other ground, when the picture reads better there */
export function plateFor(stats: PictureStats | null, theme: Theme): Plate | null {
  if (!stats?.cutout) return null;
  const here = theme === 'light' ? stats.onLight : stats.onDark;
  const there = theme === 'light' ? stats.onDark : stats.onLight;
  if (here >= ENOUGH || there <= here) return null;
  return theme === 'light' ? 'dark' : 'light';
}

// ── measuring, once per picture ─────────────────────────────────────────
const MAX_REMEMBERED = 400;
const measured = new Map<string, PictureStats | null>();
const measuring = new Map<string, Promise<PictureStats | null>>();

function remember(src: string, stats: PictureStats | null): PictureStats | null {
  if (measured.size >= MAX_REMEMBERED) measured.delete(measured.keys().next().value as string);
  measured.set(src, stats);
  return stats;
}

function measure(src: string): Promise<PictureStats | null> {
  return new Promise((resolve) => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) {
      resolve(null);
      return;
    }
    const img = new Image();
    // a remote logo is read through CORS (logo.dev answers with *); a refusal only means no plate
    if (/^https?:/i.test(src)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const ratio = img.naturalWidth > 0 && img.naturalHeight > 0 ? img.naturalWidth / img.naturalHeight : 1;
        canvas.width = ratio >= 1 ? SAMPLE_PX : Math.max(1, Math.round(SAMPLE_PX * ratio));
        canvas.height = ratio >= 1 ? Math.max(1, Math.round(SAMPLE_PX / ratio)) : SAMPLE_PX;
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(pictureStats(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch {
        resolve(null); // a tainted canvas: the picture's server refused to be read
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function statsOf(src: string): Promise<PictureStats | null> {
  let pending = measuring.get(src);
  if (!pending) {
    pending = measure(src).then((stats) => {
      measuring.delete(src);
      return remember(src, stats);
    });
    measuring.set(src, pending);
  }
  return pending;
}

// ── the theme, without a provider (pictures render everywhere) ──────────
const themeListeners = new Set<() => void>();
let themeObserver: MutationObserver | null = null;
const themeNow = (): Theme => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
function subscribeTheme(listener: () => void): () => void {
  themeListeners.add(listener);
  if (!themeObserver && typeof MutationObserver === 'function') {
    themeObserver = new MutationObserver(() => themeListeners.forEach((notify) => notify()));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  return () => {
    themeListeners.delete(listener);
    if (themeListeners.size > 0) return;
    themeObserver?.disconnect();
    themeObserver = null;
  };
}

/** #522: the plate this picture needs on the current theme — measured once per picture, remembered for the session */
export function usePicturePlate(src: string | null | undefined): Plate | null {
  const theme = useSyncExternalStore(subscribeTheme, themeNow, () => 'light' as Theme);
  const [answer, setAnswer] = useState<{ src: string; stats: PictureStats | null } | null>(null);
  useEffect(() => {
    if (!src || measured.has(src)) return;
    let live = true;
    void statsOf(src).then((stats) => {
      if (live) setAnswer({ src, stats });
    });
    return () => {
      live = false;
    };
  }, [src]);
  if (!src) return null;
  const stats = answer?.src === src ? answer.stats : (measured.get(src) ?? null);
  return plateFor(stats, theme);
}
