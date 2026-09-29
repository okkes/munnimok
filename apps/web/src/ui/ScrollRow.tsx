import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * #376 (user): a horizontal strip that SAYS it scrolls. Scrollbars are
 * hidden app-wide, so a row of chips or tiles gave no hint that more sat
 * to the right — the edge with more content now fades out under a small
 * chevron, and the fade lifts the moment that end is reached (both
 * sides). The fade paints in the host's background tone.
 */
export function ScrollRow({
  children,
  className = '',
  scrollerClassName = 'gap-2 pb-1',
  tone = 'bg',
  testId,
}: Readonly<{
  children: ReactNode;
  /** classes for the wrapper (margins) */
  className?: string;
  /** classes for the scroller itself, next to `flex overflow-x-auto` */
  scrollerClassName?: string;
  /** the background the fades melt into */
  tone?: 'bg' | 'surface' | 'bg-2';
  testId?: string;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el || typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(update);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [update, children]);
  const color = `var(--m-${tone})`;
  return (
    <div
      className={`relative ${className}`.trim()}
      data-scroll-row=""
      data-more-left={edges.left ? '1' : undefined}
      data-more-right={edges.right ? '1' : undefined}
    >
      <div ref={ref} onScroll={update} className={`flex overflow-x-auto ${scrollerClassName}`} data-testid={testId}>
        {children}
      </div>
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 left-0 w-8 transition-opacity ${edges.left ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: `linear-gradient(to right, ${color}, transparent)` }}
      />
      <div
        aria-hidden
        className={`pointer-events-none absolute inset-y-0 right-0 flex w-10 items-center justify-end pr-0.5 transition-opacity ${edges.right ? 'opacity-100' : 'opacity-0'}`}
        style={{ background: `linear-gradient(to left, ${color}, transparent)` }}
      >
        <Icon name="chevron-right" size={14} color="var(--m-ink-4)" />
      </div>
    </div>
  );
}
