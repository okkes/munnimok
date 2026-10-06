import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';

/** zoom relative to "fit the width": 1 draws a page as wide as the frame */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.25;

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

/** the bytes behind a base64 data URL */
export function dataUrlBytes(dataUrl: string): Uint8Array {
  const comma = dataUrl.indexOf(',');
  const binary = atob(comma < 0 ? '' : dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** pdf.js arrives only when an invoice is opened (the type import above costs nothing); its worker is a bundled asset */
async function openPdf(dataUrl: string): Promise<PDFDocumentProxy> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    const worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  }
  return pdfjs.getDocument({ data: dataUrlBytes(dataUrl) }).promise;
}

/** a WebKit pinch event (Safari's own, ahead of the pointer pair) */
interface GestureEvent extends Event {
  scale: number;
}

/**
 * The invoice drawn by pdf.js (user 2026-10-06): every page as wide as the
 * frame, so the reader only scrolls down; the toolbar, ctrl/⌘ + wheel and
 * a two-finger pinch zoom in and out (up to 4×, never under the width).
 * The browser's own PDF plugin was the previous answer - it fit the page
 * instead of the width, zoomed as it pleased, and Android had none at all.
 */
export function PdfView({ dataUrl, testId }: Readonly<{ dataUrl: string; testId: string }>) {
  const { t } = useLang();
  const frameRef = useRef<HTMLDivElement>(null);
  const canvases = useRef<(HTMLCanvasElement | null)[]>([]);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  /** the live factor while two fingers are on the frame (a CSS preview; the pages redraw when they lift) */
  const [pinch, setPinch] = useState<number | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);

  useEffect(() => {
    let alive = true;
    setDoc(null);
    setFailed(false);
    openPdf(dataUrl)
      .then((opened) => {
        if (alive) setDoc(opened);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [dataUrl]);

  // the frame's width lays the pages out (a ResizeObserver where there is one; tests have none)
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const read = () => setFrameWidth(el.clientWidth);
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // every page at fit-width × zoom, sharp for the device's pixel ratio
  useEffect(() => {
    if (!doc || frameWidth <= 0) return;
    let alive = true;
    const dpr = globalThis.devicePixelRatio || 1;
    const draw = async () => {
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (frameWidth / base.width) * zoom * dpr });
        const canvas = canvases.current[n - 1];
        if (!alive || !canvas) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const context = canvas.getContext('2d');
        if (context) await page.render({ canvasContext: context, canvas, viewport }).promise;
      }
    };
    draw().catch(() => {
      if (alive) setFailed(true);
    });
    return () => {
      alive = false;
    };
  }, [doc, frameWidth, zoom]);

  // the frame owns its pointers (the sheet never drags under a pinch):
  // two fingers scale a CSS preview and commit on lift; Safari's gesture
  // events do the same; ctrl/⌘ + wheel steps the zoom on a desktop
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let startDistance = 0;
    let startZoom = 1;
    let live: number | null = null;
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const preview = (next: number) => {
      live = clampZoom(next);
      setPinch(live / zoomRef.current);
    };
    const commit = () => {
      if (live === null) return;
      const next = live;
      live = null;
      setPinch(null);
      setZoom(next);
    };
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        startDistance = distance();
        startZoom = zoomRef.current;
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && startDistance > 0) {
        e.preventDefault();
        preview(startZoom * (distance() / startDistance));
      }
    };
    const up = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (pointers.size < 2) {
        startDistance = 0;
        commit();
      }
    };
    const gestureStart = () => {
      startZoom = zoomRef.current;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      preview(startZoom * (e as GestureEvent).scale);
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    const keepTouch = (e: TouchEvent) => {
      e.stopPropagation();
      if (e.touches.length > 1) e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('gesturestart', gestureStart);
    el.addEventListener('gesturechange', gestureChange);
    el.addEventListener('gestureend', commit);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('touchstart', keepTouch, { passive: false });
    el.addEventListener('touchmove', keepTouch, { passive: false });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('gesturestart', gestureStart);
      el.removeEventListener('gesturechange', gestureChange);
      el.removeEventListener('gestureend', commit);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('touchstart', keepTouch);
      el.removeEventListener('touchmove', keepTouch);
    };
  }, []);

  const step = (factor: number) => setZoom((z) => clampZoom(z * factor));
  const pageCount = doc?.numPages ?? 0;
  const tool = 'm-tap flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-ink disabled:opacity-40';
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2 px-1 text-[12px] text-ink-3">
        <span className="min-w-0 flex-1 truncate" data-testid={`${testId}-pages`}>
          {pageCount > 0 ? t('receipts.pageCount', { n: pageCount }) : failed ? t('receipts.pdfFailed') : t('receipts.pdfLoading')}
        </span>
        <button type="button" aria-label={t('receipts.zoomOut')} data-testid={`${testId}-zoom-out`} disabled={zoom <= ZOOM_MIN} onClick={() => step(1 / ZOOM_STEP)} className={tool}>
          <Icon name="minus" size={16} />
        </button>
        <button type="button" aria-label={t('receipts.zoomFit')} data-testid={`${testId}-zoom-fit`} onClick={() => setZoom(1)} className="m-tap h-8 min-w-12 rounded-full border border-line bg-surface px-2 font-mono text-[11px] text-ink">
          <span data-testid={`${testId}-zoom`}>{Math.round(zoom * 100)}%</span>
        </button>
        <button type="button" aria-label={t('receipts.zoomIn')} data-testid={`${testId}-zoom-in`} disabled={zoom >= ZOOM_MAX} onClick={() => step(ZOOM_STEP)} className={tool}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      <div
        ref={frameRef}
        data-sheet-own-gesture
        data-testid={`${testId}-frame`}
        className="h-[calc(100dvh-250px)] overflow-auto overscroll-contain rounded-card border border-line bg-bg-2 lg:h-[min(calc(92dvh-250px),760px)]"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        <div className="flex flex-col items-start gap-2 p-2" style={pinch ? { transform: `scale(${pinch})`, transformOrigin: '0 0' } : undefined}>
          {Array.from({ length: pageCount }, (_, i) => (
            <canvas
              key={i}
              ref={(el) => {
                canvases.current[i] = el;
              }}
              data-testid={`${testId}-page-${i + 1}`}
              className="bg-white shadow-sm"
            />
          ))}
        </div>
      </div>
    </div>
  );
}
