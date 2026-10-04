import { useEffect, useRef, useState } from 'react';
import { CENTER_FOCUS, coverOverflow, focusPosition, panFocus } from '@/lib/imageFocus';
import type { ImageFocus, Size } from '@/lib/imageFocus';
import { Icon } from './Icon';

/**
 * #446 (user): "allow the user to drag the showable area". A frame in the
 * shape the picture will be shown in; the picture sits in it cover-fitted
 * and the person drags it to choose which part stays visible. Pure pan
 * (no zoom): the hero, the card and the Home tile all crop the same
 * picture, each at its own height, so what is stored is a FOCUS — two
 * object-position percentages — not a cut-out, and every renderer applies
 * the same focus to its own frame.
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
}: Readonly<{
  src: string;
  /** the stored focus; undefined/null = the centre */
  focus: ImageFocus | null | undefined;
  onFocus: (next: ImageFocus) => void;
  /** the one-line instruction shown on the frame (localized by the caller) */
  hint: string;
  testId: string;
  className?: string;
}>) {
  // the element via state (callback ref), so the listeners bind once it exists
  const [frameEl, setFrameEl] = useState<HTMLDivElement | null>(null);
  const current = focus ?? CENTER_FOCUS;
  // the listeners read the LATEST focus and callback through refs — they
  // are bound once per element, not once per render
  const focusRef = useRef(current);
  focusRef.current = current;
  const onFocusRef = useRef(onFocus);
  onFocusRef.current = onFocus;
  const naturalRef = useRef<Size | null>(null);

  useEffect(() => {
    const el = frameEl;
    if (!el) return;
    let drag: { pointerId: number; x: number; y: number; start: ImageFocus } | null = null;
    const down = (e: PointerEvent) => {
      e.stopPropagation();
      drag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY, start: focusRef.current };
      try {
        el.setPointerCapture?.(e.pointerId);
      } catch {
        // test DOMs throw on capture without an active pointer — the drag
        // works from the move events either way, capture is a real-device nicety
      }
    };
    const move = (e: PointerEvent) => {
      const natural = naturalRef.current;
      if (drag?.pointerId !== e.pointerId || !natural) return;
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const next = panFocus(drag.start, e.clientX - drag.x, e.clientY - drag.y, coverOverflow(natural, { width: rect.width, height: rect.height }));
      const now = focusRef.current;
      if (next.x !== now.x || next.y !== now.y) onFocusRef.current(next);
    };
    const up = (e: PointerEvent) => {
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

  return (
    <div
      ref={setFrameEl}
      data-testid={testId}
      data-sheet-own-gesture
      className={`relative h-28 w-full cursor-grab touch-none select-none overflow-hidden rounded-xl border-2 border-accent active:cursor-grabbing ${className}`}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        onLoad={(e) => {
          naturalRef.current = { width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight };
        }}
        className="pointer-events-none h-full w-full object-cover"
        style={{ objectPosition: focusPosition(current) }}
        data-testid={`${testId}-img`}
      />
      <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-1 rounded-lg bg-black/45 px-2 py-0.5 text-[10px] text-white backdrop-blur-sm">
        <Icon name="cursor-move" size={12} />
        {hint}
      </span>
    </div>
  );
}
