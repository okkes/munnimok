import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, UIEvent } from 'react';

/**
 * #273 (user): the ride-along search must GLIDE, not pop. The old
 * translate+height:0 toggle jumped (auto height doesn't animate) and
 * left a void where the field had been. This pair is the one mechanic
 * for every scroll-away search in the app:
 *
 * - `useSearchCollapse` keeps the deliberate-up-travel rule: browsing
 *   down slips the field away, one field's worth of upward travel (or
 *   being near the top) brings it back; rubber-band frames never count.
 * - `CollapsingSearch` animates a MEASURED max-height together with
 *   opacity and a small translate, so the list below grows into the
 *   freed space smoothly instead of snapping.
 */
export function useSearchCollapse(searchH: number) {
  const [shown, setShown] = useState(true);
  const lastScrollTop = useRef(0);
  const upTravel = useRef(0);
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = el.scrollTop;
    const delta = lastScrollTop.current - top; // > 0 → upward
    lastScrollTop.current = top;
    const maxTop = el.scrollHeight - el.clientHeight;
    if (top < 0 || top > maxTop - searchH) {
      upTravel.current = 0;
      return;
    }
    if (delta > 0) upTravel.current += delta;
    else if (delta < 0) upTravel.current = 0;
    setShown(upTravel.current >= searchH || top < searchH);
  };
  return { shown, onListScroll };
}

export function CollapsingSearch({ shown, children, testId }: Readonly<{ shown: boolean; children: ReactNode; testId?: string }>) {
  const inner = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (inner.current) setMeasured(inner.current.scrollHeight);
  }, [children]);
  return (
    <div
      data-testid={testId}
      className="overflow-hidden transition-[max-height,opacity,transform] duration-200 ease-out"
      style={{
        // `|| 200`: environments without layout (tests) measure 0 — the
        // cap must still open, only the animation loses its exact end
        maxHeight: shown ? (measured || 200) : 0,
        opacity: shown ? 1 : 0,
        transform: shown ? 'none' : 'translateY(-10px)',
        pointerEvents: shown ? undefined : 'none',
      }}
    >
      <div ref={inner}>{children}</div>
    </div>
  );
}
