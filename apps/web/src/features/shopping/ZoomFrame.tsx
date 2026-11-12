import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLang } from '@/i18n';
import { Icon } from '@/ui/Icon';

/** zoom relative to "fit the width": 1 draws the content as wide as the frame */
export const ZOOM_MIN = 1;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 1.25;
/** where a double tap lands from the width (#568: one gesture to read a receipt's line) */
export const ZOOM_TAP = 2.5;

export const clampZoom = (zoom: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 100) / 100));

/** the content's inset inside the frame (p-2) — it does not scale with the zoom */
const PAD = 8;
/** two taps within this long and this close are a double tap */
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 32;
/** a wheel run (a trackpad pinch is one) previews, then commits once it rests */
const WHEEL_REST_MS = 160;

/** a point in the frame's own box, from its top-left corner */
interface FramePoint {
  x: number;
  y: number;
}

/** a WebKit pinch event (Safari's own, ahead of the pointer pair) */
interface GestureEvent extends Event {
  scale: number;
  clientX: number;
  clientY: number;
}

interface ZoomGestures {
  zoomRef: { readonly current: number };
  /** a live factor over the committed zoom around a point (a CSS preview), or null when the gesture ends */
  onPreview: (factor: number | null, at: FramePoint) => void;
  /** the new zoom, around the point that must stay where it is */
  onCommit: (zoom: number, at: FramePoint) => void;
}

/**
 * The frame's own gestures: two fingers (or Safari's gesture events) pinch
 * a preview committed on lift, ctrl/⌘ + wheel — a trackpad pinch on a
 * desktop — zooms at the cursor, a double tap or double click zooms in at
 * that point and back out to the width, and a mouse drag pans. One finger
 * scrolls natively. The frame owns its pointers: the sheet never drags
 * under a pinch (`data-sheet-own-gesture` + the stop on pointerdown).
 */
function useZoomGestures(frameRef: { readonly current: HTMLElement | null }, gestures: ZoomGestures): void {
  const latest = useRef(gestures);
  latest.current = gestures;
  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    const local = (clientX: number, clientY: number): FramePoint => {
      const box = el.getBoundingClientRect();
      return { x: clientX - box.left, y: clientY - box.top };
    };
    const pointers = new Map<number, { x: number; y: number }>();
    let startDistance = 0;
    let startZoom = 1;
    let live: number | null = null;
    let focus: FramePoint = { x: 0, y: 0 };
    let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
    let press: { x: number; y: number } | null = null;
    let lastTap: { time: number; x: number; y: number } | null = null;
    let wheelRest: ReturnType<typeof setTimeout> | null = null;

    const preview = (next: number, at: FramePoint) => {
      live = clampZoom(next);
      focus = at;
      latest.current.onPreview(live / latest.current.zoomRef.current, at);
    };
    const commit = () => {
      if (live === null) return;
      const next = live;
      live = null;
      latest.current.onPreview(null, focus);
      latest.current.onCommit(next, focus);
    };
    const pair = () => {
      const [a, b] = [...pointers.values()];
      return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: local((a.x + b.x) / 2, (a.y + b.y) / 2) };
    };
    const tapped = (e: PointerEvent) => {
      const at = local(e.clientX, e.clientY);
      const now = performance.now();
      if (lastTap && now - lastTap.time <= DOUBLE_TAP_MS && Math.hypot(at.x - lastTap.x, at.y - lastTap.y) <= DOUBLE_TAP_PX) {
        lastTap = null;
        // in at the point, or back out to the width when already in
        latest.current.onCommit(latest.current.zoomRef.current > ZOOM_MIN ? ZOOM_MIN : ZOOM_TAP, at);
        return;
      }
      lastTap = { time: now, ...at };
    };

    const down = (e: PointerEvent) => {
      e.stopPropagation();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2) {
        startDistance = pair().distance;
        startZoom = latest.current.zoomRef.current;
        drag = null;
        press = null;
        lastTap = null;
        return;
      }
      press = { x: e.clientX, y: e.clientY };
      if (e.pointerType === 'mouse' && e.button === 0) {
        drag = { x: e.clientX, y: e.clientY, left: el.scrollLeft, top: el.scrollTop, moved: false };
        // without the capture a button let go beyond the frame never reports here, and the drag follows the bare cursor
        el.setPointerCapture?.(e.pointerId);
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && startDistance > 0) {
        e.preventDefault();
        const { distance, mid } = pair();
        preview(startZoom * (distance / startDistance), mid);
        return;
      }
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 10) press = null;
      if (!drag) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      el.dataset.dragging = '1';
      el.scrollLeft = drag.left - dx;
      el.scrollTop = drag.top - dy;
    };
    const up = (e: PointerEvent) => {
      if (!pointers.delete(e.pointerId)) return;
      if (startDistance > 0) {
        if (pointers.size < 2) {
          startDistance = 0;
          commit();
        }
        return;
      }
      if (e.type === 'pointerup' && press) tapped(e);
      press = null;
      drag = null;
      delete el.dataset.dragging;
    };
    const gestureStart = () => {
      startZoom = latest.current.zoomRef.current;
    };
    const gestureChange = (e: Event) => {
      e.preventDefault();
      const g = e as GestureEvent;
      preview(startZoom * g.scale, local(g.clientX, g.clientY));
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      preview((live ?? latest.current.zoomRef.current) * (e.deltaY < 0 ? 1.1 : 1 / 1.1), local(e.clientX, e.clientY));
      if (wheelRest) clearTimeout(wheelRest);
      wheelRest = setTimeout(commit, WHEEL_REST_MS);
    };
    const keepTouch = (e: TouchEvent) => {
      e.stopPropagation();
      if (e.touches.length > 1) e.preventDefault();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('lostpointercapture', up);
    el.addEventListener('gesturestart', gestureStart);
    el.addEventListener('gesturechange', gestureChange);
    el.addEventListener('gestureend', commit);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('touchstart', keepTouch, { passive: false });
    el.addEventListener('touchmove', keepTouch, { passive: false });
    return () => {
      if (wheelRest) clearTimeout(wheelRest);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('lostpointercapture', up);
      el.removeEventListener('gesturestart', gestureStart);
      el.removeEventListener('gesturechange', gestureChange);
      el.removeEventListener('gestureend', commit);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('touchstart', keepTouch);
      el.removeEventListener('touchmove', keepTouch);
    };
  }, [frameRef]);
}

/**
 * A zoomable frame (#568, the invoice viewer's since 2026-10-06): the
 * toolbar (status, −, the zoom that resets to the width, +) over a scroll
 * frame whose content is drawn at `width` — the frame's width × the zoom.
 * Every zoom keeps its point in place: the fingers' middle, the cursor, the
 * tapped spot, or the frame's centre for the buttons.
 */
export function ZoomFrame({
  testId,
  status,
  children,
}: Readonly<{
  testId: string;
  /** the line left of the buttons: the pages, or how to zoom */
  status: ReactNode;
  /** the content at the given CSS width */
  children: (width: number) => ReactNode;
}>) {
  const { t } = useLang();
  const frameRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;
  // the live preview: a factor around a point of the content (the scroll offset plus the frame point)
  const [pinch, setPinch] = useState<{ factor: number; origin: FramePoint } | null>(null);
  const [frameWidth, setFrameWidth] = useState(0);
  /** where the committed zoom must leave the scroll, applied once the content has its new size */
  const anchor = useRef<{ ratio: number; at: FramePoint; left: number; top: number } | null>(null);

  // the frame's width lays the content out (a ResizeObserver where there is one; tests have none)
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

  const zoomTo = (next: number, at: FramePoint) => {
    const el = frameRef.current;
    const target = clampZoom(next);
    if (!el || target === zoomRef.current) return;
    anchor.current = { ratio: target / zoomRef.current, at, left: el.scrollLeft, top: el.scrollTop };
    setZoom(target);
  };
  useLayoutEffect(() => {
    const el = frameRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    anchor.current = null;
    el.scrollLeft = Math.max(0, (a.left + a.at.x - PAD) * a.ratio + PAD - a.at.x);
    el.scrollTop = Math.max(0, (a.top + a.at.y - PAD) * a.ratio + PAD - a.at.y);
  }, [zoom]);

  useZoomGestures(frameRef, {
    zoomRef,
    onPreview: (factor, at) => {
      const el = frameRef.current;
      setPinch(factor === null || !el ? null : { factor, origin: { x: el.scrollLeft + at.x, y: el.scrollTop + at.y } });
    },
    onCommit: zoomTo,
  });

  const centre = (): FramePoint => ({ x: (frameRef.current?.clientWidth ?? 0) / 2, y: (frameRef.current?.clientHeight ?? 0) / 2 });
  const step = (factor: number) => zoomTo(zoomRef.current * factor, centre());
  const width = Math.max(0, frameWidth - 2 * PAD) * zoom;
  const previewStyle = pinch ? { transform: `scale(${pinch.factor})`, transformOrigin: `${pinch.origin.x}px ${pinch.origin.y}px` } : undefined;
  const tool = 'm-tap flex h-8 w-8 items-center justify-center rounded-full border border-line bg-surface text-ink disabled:opacity-40';
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex items-center gap-2 px-1 text-[12px] text-ink-3">
        <span className="min-w-0 flex-1 truncate" data-testid={`${testId}-pages`}>
          {status}
        </span>
        <button type="button" aria-label={t('receipts.zoomOut')} data-testid={`${testId}-zoom-out`} disabled={zoom <= ZOOM_MIN} onClick={() => step(1 / ZOOM_STEP)} className={tool}>
          <Icon name="minus" size={16} />
        </button>
        <button
          type="button"
          aria-label={t('receipts.zoomFit')}
          data-testid={`${testId}-zoom-fit`}
          onClick={() => zoomTo(ZOOM_MIN, centre())}
          className="m-tap h-8 min-w-12 rounded-full border border-line bg-surface px-2 font-mono text-[11px] text-ink"
        >
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
        className="h-[calc(100dvh-250px)] cursor-grab overflow-auto overscroll-contain rounded-card border border-line bg-bg-2 select-none data-[dragging=1]:cursor-grabbing lg:h-[min(calc(92dvh-250px),760px)]"
        style={{ touchAction: 'pan-x pan-y' }}
      >
        <div className="flex w-max min-w-full flex-col items-start gap-2 p-2" data-testid={`${testId}-content`} style={previewStyle}>
          {children(width)}
        </div>
      </div>
    </div>
  );
}
