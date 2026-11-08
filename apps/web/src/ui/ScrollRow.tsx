import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { useLang } from '@/i18n';
import { Icon } from './Icon';

/** how far an edge with more content fades out */
const FADE_PX = 40;

/** the content fades out toward each edge that hides more of it — a mask on the strip itself, so it melts into whatever is behind (sheet, card, page) in either theme */
export function edgeMask(left: boolean, right: boolean): CSSProperties | undefined {
  if (!left && !right) return undefined;
  const from = left ? `transparent, #000 ${FADE_PX}px` : '#000';
  const to = right ? `#000 calc(100% - ${FADE_PX}px), transparent` : '#000';
  const image = `linear-gradient(to right, ${from}, ${to})`;
  return { maskImage: image, WebkitMaskImage: image };
}

/**
 * #376 (user): a horizontal strip that SAYS it scrolls. Scrollbars are
 * hidden app-wide, so a row of chips or tiles gave no hint that more sat
 * beyond the edge. Each edge that hides more fades the content out and
 * wears a round arrow button — r2 (user: "a bit hard to see"): a solid
 * surface disc with a hairline and a shadow, readable in both themes over
 * any background, and a tap pages the strip (mouse users have no swipe).
 * Both lift the moment that end is reached.
 */
export function ScrollRow({
  children,
  className = '',
  scrollerClassName = 'gap-2 pb-1',
  testId,
}: Readonly<{
  children: ReactNode;
  /** classes for the wrapper (margins, a backdrop that must not fade) */
  className?: string;
  /** classes for the scroller itself, next to `flex overflow-x-auto` */
  scrollerClassName?: string;
  testId?: string;
}>) {
  const { t } = useLang();
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
  // the strip's bottom padding is shadow room, not content — the arrows centre on the chips
  const shadowRoom = /(^|\s)pb-1(\s|$)/.test(scrollerClassName);
  /** a tap pages the strip by most of its width — the next chip lands where the arrow was */
  const page = (direction: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const left = direction * Math.max(80, Math.round(el.clientWidth * 0.75));
    const smooth = !globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (typeof el.scrollBy === 'function') el.scrollBy({ left, behavior: smooth ? 'smooth' : 'auto' });
    else el.scrollLeft += left;
  };
  return (
    <div
      className={`relative ${className}`.trim()}
      data-scroll-row=""
      data-more-left={edges.left ? '1' : undefined}
      data-more-right={edges.right ? '1' : undefined}
    >
      <div ref={ref} onScroll={update} className={`flex overflow-x-auto ${scrollerClassName}`} style={edgeMask(edges.left, edges.right)} data-testid={testId}>
        {children}
      </div>
      <EdgeArrow side="left" shown={edges.left} label={t('ui.scrollLeft')} onClick={() => page(-1)} testId={testId} lift={shadowRoom} />
      <EdgeArrow side="right" shown={edges.right} label={t('ui.scrollRight')} onClick={() => page(1)} testId={testId} lift={shadowRoom} />
    </div>
  );
}

function EdgeArrow({
  side,
  shown,
  label,
  onClick,
  testId,
  lift,
}: Readonly<{ side: 'left' | 'right'; shown: boolean; label: string; onClick: () => void; testId?: string; lift: boolean }>) {
  return (
    <button
      type="button"
      // the chips themselves take keyboard focus (and scroll into view); the arrows are for pointers
      tabIndex={-1}
      aria-label={label}
      aria-hidden={!shown}
      data-edge={side}
      data-testid={testId ? `${testId}-${side}` : undefined}
      onClick={onClick}
      className={`absolute z-10 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full border border-line bg-surface text-ink-2 shadow-[0_2px_8px_rgba(0,0,0,0.18)] transition-opacity duration-200 active:scale-95 ${
        lift ? 'top-[calc(50%-2px)]' : 'top-1/2'
      } ${side === 'left' ? 'left-0' : 'right-0'} ${shown ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
    >
      <Icon name={side === 'left' ? 'chevron-left' : 'chevron-right'} size={18} />
    </button>
  );
}
