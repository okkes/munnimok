import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** how long a height change takes — the folds' pace (Collapse) */
const GROW_MS = 240;

/** #540: the box's height eases to its content's, clipping only while it moves; plain auto height until measured */
export function AutoHeight({ children, className, testId }: Readonly<{ children: ReactNode; className?: string; testId?: string }>) {
  const outer = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const box = outer.current;
    const content = inner.current;
    if (!box || !content || typeof ResizeObserver === 'undefined') return;
    let last: number | null = null;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      const next = content.getBoundingClientRect().height;
      if (next === last) return;
      if (last !== null) {
        box.style.overflow = 'hidden';
        clearTimeout(settle);
        settle = setTimeout(() => {
          box.style.overflow = '';
        }, GROW_MS + 40);
      }
      box.style.height = `${next}px`;
      last = next;
    });
    observer.observe(content);
    return () => {
      observer.disconnect();
      clearTimeout(settle);
    };
  }, []);
  return (
    <div ref={outer} className={className} style={{ transition: `height ${GROW_MS}ms ease-out` }} data-testid={testId}>
      {/* flow-root: the content's own margins stay inside what is measured */}
      <div ref={inner} className="flow-root">
        {children}
      </div>
    </div>
  );
}
