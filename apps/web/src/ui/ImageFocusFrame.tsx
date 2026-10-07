import { useEffect, useRef, useState } from 'react';
import { CENTER_FOCUS, SCALE_MAX, SCALE_MIN, clampScale, coverOverflow, focusStyle, panFocus } from '@/lib/imageFocus';
import type { ImageFocus, Size } from '@/lib/imageFocus';
import { Icon } from './Icon';

/**
 * #446 (user): "allow the user to drag the showable area". A frame in the
 * shape the picture will be shown in; the picture sits in it cover-fitted
 * and the person drags it to choose which part stays visible. What is
 * stored is a FOCUS — two object-position percentages, and since
 * 2026-10-06 (user) a zoom around that point — not a cut-out, so the hero,
 * the card, the Home tile and every round avatar crop the same picture at
 * their own sizes and every renderer applies the same focus to its frame.
 *
 * A `circle` frame is the avatar's square with the circle drawn over it,
 * so the person sees exactly what the round picture will keep; `zoom`
 * adds a slider and a two-finger pinch.
 *
 * NATIVE pointer listeners that stop the event themselves, like the color
 * wheel's, so the sheet library's drag never arms under a pan. The frame
 * is marked `data-sheet-own-gesture`: the Sheet's capture guard stands
 * down for it (a stop there happens at React's root and would never let
 * the pointer reach these listeners - the `data-sheet-no-drag` answer is
 * for content that has no handlers of its own). Touch events are kept
 * from the sheet the same way, and `touch-none` keeps the page from
 * scrolling under a vertical pan.
 */
export function ImageFocusFrame({
  src,
  focus,
  onFocus,
  hint,
  testId,
  className = '',
  shape = 'rect',
  zoom = false,
  zoomLabel = 'Zoom',
}: Readonly<{
  src: string;
  /** the stored focus; undefined/null = the centre at 1× */
  focus: ImageFocus | null | undefined;
  onFocus: (next: ImageFocus) => void;
  /** the one-line instruction shown on the frame (localized by the caller) */
  hint: string;
  testId: string;
  className?: string;
  /** the shape the picture will be shown in: the wide rectangle, or the avatar's circle */
  shape?: 'rect' | 'circle';
  /** a slider under the frame and a two-finger pinch change the scale */
  zoom?: boolean;
  zoomLabel?: string;
}>) {
  // the element via state (callback ref), so the listeners bind once it exists
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const current = focus ?? CENTER_FOCUS;
  const scale = clampScale(current.scale);
  // the listeners read the LATEST focus and callback through refs — they
  // are bound once per element, not once per render
  const focusRef = useRef(current);
  focusRef.current = current;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const naturalRef = useRef<Size | null>(null);

  useEffect(() => {
    const el = frameEl;
    if (!el) return;
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { pointerId: number; x: number; y: number; start: ImageFocus } | null = null;
    // two fingers: the distance between them scales the picture
    let pinch: { distance: number; scale: number } | null = null;
    const distance = () => {
      const [a, b] = [...pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 2 && zoomRef.current) {
        drag = null;
        pinch = { distance: distance(), scale: clampScale(focusRef.current.scale) };
        return;
      }
      if (pointers.size !== 1) return;
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, start: focusRef.current };
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // test DOMs throw on capture without an active pointer — the drag
        // works from the move events either way, capture is a real-device nicety
      }
    };
    const move = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        e.stopPropagation();
        const next = clampScale(pinch.scale * (distance() / pinch.distance));
        if (next !== clampScale(focusRef.current.scale)) onFocusRef.current({ ...focusRef.current, scale: next });
        return;
      }
      const natural = naturalRef.current;
      if (drag?.pointerId !== e.pointerId || !natural) return;
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const overflow = coverOverflow(natural, { width: rect.width, height: rect.height }, clampScale(focusRef.current.scale));
      const next = panFocus(drag.start, e.clientX - drag.x, e.clientY - drag.y, overflow);
      const now = focusRef.current;
      if (next.x !== now.x || next.y !== now.y) onFocusRef.current(next);
    };
    const up = (e: PointerEvent) => {
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      if (drag?.pointerId === e.pointerId) drag = null;
    };
    const keepTouch = (e: TouchEvent) => e.stopPropagation();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('touchstart', keepTouch, { passive: true });
    el.addEventListener('touchmove', keepTouch, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('touchstart', keepTouch);
      el.removeEventListener('touchmove', keepTouch);
    };
  }, [frameEl]);

  const frameShape = shape === 'circle' ? 'mx-auto h-40 w-40' : 'h-28 w-full';
  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <div
        ref={setFrameEl}
        data-testid={testId}
        data-sheet-own-gesture
        data-shape={shape}
        className={`relative cursor-grab touch-none select-none overflow-hidden rounded-xl border-2 border-accent active:cursor-grabbing ${frameShape}`}
      >
        <img
          src={src}
          alt=""
          draggable={false}
          onLoad={(e) => {
            naturalRef.current = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight };
          }}
          className="pointer-events-none h-full w-full object-cover"
          style={focusStyle(current)}
          data-testid={`${testId}-img`}
        />
        {/* the circle the avatar keeps: everything outside it dims */}
        {shape === 'circle' && (
          <span
            aria-hidden
            data-testid={`${testId}-mask`}
            className="pointer-events-none absolute inset-0 rounded-full shadow-[0_0_0_200px_rgba(0,0,0,0.45)]"
          />
        )}
      </div>
      {/* the hint stands under the picture (user 2026-10-07): on it, it hid the face being framed */}
      <p className="flex items-center justify-center gap-1 px-1 text-center text-[11px] text-ink-3" data-testid={`${testId}-hint`}>
        <Icon name="cursor-move" size={12} color="var(--m-ink-4)" />
        {hint}
      </p>
      {zoom && (
        <label className="flex items-center gap-2 px-1 text-[11px] text-ink-3">
          <Icon name="magnify-minus-outline" size={14} color="var(--m-ink-4)" />
          <input
            type="range"
            min={SCALE_MIN}
            max={SCALE_MAX}
            step={0.05}
            value={scale}
            aria-label={zoomLabel}
            data-testid={`${testId}-zoom`}
            onChange={(e) => onFocus({ ...current, scale: clampScale(Number(e.target.value)) })}
            className="min-w-0 flex-1 accent-[var(--m-accent)]"
          />
          <Icon name="magnify-plus-outline" size={14} color="var(--m-ink-4)" />
        </label>
      )}
    </div>
  );
}
