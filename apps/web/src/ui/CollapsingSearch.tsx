import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, UIEvent } from 'react';

// the ride-along search moves 1:1 with the scroll, no animation or thresholds; rubber-band frames never count (#273)
export function useSearchCollapse(searchH: number, resetKey?: unknown) {
  const [offset, setOffset] = useState(0);
  const lastScrollTop = useRef(0);
  // #273: a sheet that stays mounted reopens with the field collapsed — hosts reset on open
  const reset = () => {
    setOffset(0);
    lastScrollTop.current = 0;
  };
  // #323: filtering shrank the content while the offset held the field collapsed; the stale slack left phantom scroll
  // range that rubber-banded forever — a resetKey change restores the field, hosts rewind their scroller with it
  const keyRef = useRef(resetKey);
  useEffect(() => {
    if (Object.is(keyRef.current, resetKey)) return;
    keyRef.current = resetKey;
    setOffset(0);
    lastScrollTop.current = 0;
  }, [resetKey]);
  const onListScroll = (e: UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    const top = el.scrollTop;
    const delta = top - lastScrollTop.current;
    lastScrollTop.current = Math.max(0, top);
    const maxTop = el.scrollHeight - el.clientHeight;
    // rubber band: bounce frames at either end must not eat the field
    if (top < 0 || top > maxTop) return;
    // #323: growth is capped at the scroll room still below, else on a short filtered list
    // the browser clamps back and the tug-of-war bounces forever
    const step = delta > 0 ? Math.min(delta, Math.max(0, maxTop - top)) : delta;
    setOffset((prev) => Math.min(searchH, Math.max(0, prev + step)));
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
      <div ref={inner} style={{ transform: offset ? `translateY(-${offset}px)` : undefined }}>
        {children}
      </div>
    </div>
  );
}
