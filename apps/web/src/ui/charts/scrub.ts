import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { CSSProperties, MouseEvent, PointerEvent } from 'react';

/** where an arrow key moves the scrubbed index (null = Escape clears, undefined = not a scrub key) */
export function scrubKeyTarget(key: string, current: number, count: number): number | null | undefined {
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, current + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'Escape') return null;
  return undefined;
}

/** 0…1 across the chart; happy-dom lays nothing out, so a zero-width box reads as the left edge */
export function fractionAt(el: Element, clientX: number): number {
  const rect = el.getBoundingClientRect();
  const fraction = rect.width > 0 ? (clientX - rect.left) / rect.width : 0;
  return Math.min(1, Math.max(0, fraction));
}

/** #510: a finger resting this long on a chart reads it; one that moves sooner is scrolling the page */
export const SCRUB_HOLD_MS = 400;
/** a resting finger still trembles: this far it may wander before the press counts as a scroll */
const HOLD_SLOP_PX = 10;

/** vertical scrolling stays the browser's until a hold takes the finger; no callout or selection on a long press */
const SCRUB_STYLE: CSSProperties = {
  touchAction: 'pan-y',
  cursor: 'crosshair',
  userSelect: 'none',
  WebkitUserSelect: 'none',
  WebkitTouchCallout: 'none',
};

type Pick = (index: number | null, follow: boolean) => void;

interface Press {
  id: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** a pen or a finger shares the page with scrolling; a mouse reads the chart directly */
const isTouch = (e: PointerEvent): boolean => e.pointerType === 'touch' || e.pointerType === 'pen';

/**
 * The pointer side of a chart's day scrub (#510): a mouse hovers or drags as before; a finger only reads the chart
 * after resting on it for SCRUB_HOLD_MS, then holds the page still and drags the day until it lifts.
 */
export function useScrubPointer({ indexAt, pick, scrubbing }: Readonly<{ indexAt: (fraction: number) => number; pick: Pick; scrubbing: boolean }>) {
  const latest = useRef({ indexAt, pick });
  useLayoutEffect(() => {
    latest.current = { indexAt, pick };
  });
  const press = useRef<Press | null>(null);
  const held = useRef(false);
  const stopTimer = () => clearTimeout(press.current?.timer ?? undefined);
  useEffect(() => () => clearTimeout(press.current?.timer ?? undefined), []);

  // React listens to touchmove passively, so only a listener of our own can keep the page from scrolling
  const ref = useCallback((el: SVGSVGElement | null) => {
    if (!el) return;
    const hold = (e: TouchEvent) => {
      if (held.current && e.cancelable) e.preventDefault();
    };
    el.addEventListener('touchmove', hold, { passive: false });
    return () => el.removeEventListener('touchmove', hold);
  }, []);

  const release = () => {
    stopTimer();
    press.current = null;
    held.current = false;
    pick(null, false);
  };
  const indexOf = (e: PointerEvent<SVGSVGElement>) => indexAt(fractionAt(e.currentTarget, e.clientX));

  const handlers = {
    style: SCRUB_STYLE,
    onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
      if (!isTouch(e)) {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        pick(indexOf(e), false);
        return;
      }
      if (press.current) return;
      const el = e.currentTarget;
      const { pointerId: id, clientX: x, clientY: y } = e;
      press.current = {
        id,
        x,
        y,
        timer: setTimeout(() => {
          if (press.current?.id !== id) return;
          press.current.timer = null;
          held.current = true;
          latest.current.pick(latest.current.indexAt(fractionAt(el, x)), false);
        }, SCRUB_HOLD_MS),
      };
    },
    onPointerMove: (e: PointerEvent<SVGSVGElement>) => {
      if (!isTouch(e)) {
        pick(indexOf(e), scrubbing);
        return;
      }
      const current = press.current;
      if (current?.id !== e.pointerId) return;
      if (held.current) {
        pick(indexOf(e), true);
        return;
      }
      if (Math.hypot(e.clientX - current.x, e.clientY - current.y) > HOLD_SLOP_PX) {
        stopTimer();
        press.current = null;
      }
    },
    onPointerUp: release,
    onPointerCancel: release,
    onPointerLeave: release,
    onContextMenu: (e: MouseEvent<SVGSVGElement>) => {
      // Android opens its long-press menu just after the hold has taken the finger
      if (held.current) e.preventDefault();
    },
  };
  return { ref, handlers };
}
