import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, UIEvent } from 'react';

/**
 * #273 r2 (user): the ride-along search moves 1:1 WITH the scroll — as
 * if it were list content, not a fixed header. A little downward travel
 * hides a little of the field; upward travel reveals it by exactly the
 * scrolled amount. No animation, no thresholds — the finger owns the
 * motion. This pair is the one mechanic for every scroll-away search:
 *
 * - `useSearchCollapse` accumulates the scroll delta into an offset in
 *   [0, field height]; rubber-band frames (top bounce, bottom
 *   overscroll) never count.
 * - `CollapsingSearch` clips its measured content by that offset and
 *   slides it, so the list below flows into the freed space in the same
 *   frame the finger moves.
 */
export function useSearchCollapse(searchH: number) {
  const [offset, setOffset] = useState(0);
  const lastScrollTop = useRef(0);
  // #273 r3 (user): a sheet that stays mounted reopens with the field
  // collapsed from last time — hosts reset on open
  const reset = () => {
    setOffset(0);
    lastScrollTop.current = 0;
  };
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = el.scrollTop;
    const delta = top - lastScrollTop.current; // > 0 → scrolling down
    lastScrollTop.current = Math.max(0, top);
    const maxTop = el.scrollHeight - el.clientHeight;
    // rubber band: bounce frames at either end must not eat the field
    if (top < 0 || top > maxTop) return;
    setOffset((prev) => Math.min(searchH, Math.max(0, prev + delta)));
  };
  return { offset, searchH, onListScroll, reset };
}

export function CollapsingSearch({
  offset,
  children,
  testId,
}: Readonly<{ offset: number; children: ReactNode; testId?: string }>) {
  const inner = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (inner.current) setMeasured(inner.current.scrollHeight);
  }, [children]);
  // `|| 200`: environments without layout (tests) measure 0 — the field
  // must still show fully at offset 0
  const full = measured || 200;
  const height = Math.max(0, full - offset);
  return (
    <div
      data-testid={testId}
      className="overflow-hidden"
      style={{
        height,
        pointerEvents: height === 0 ? 'none' : undefined,
      }}
    >
      {/* the content slides away under the clip — a real scroll-out */}
      <div ref={inner} style={{ transform: offset ? `translateY(-${offset}px)` : undefined }}>
        {children}
      </div>
    </div>
  );
}
