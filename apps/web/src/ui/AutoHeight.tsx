import { useLayoutEffect, useRef } from 'react';
import type { ReactNode } from 'react';

/** how long a height change takes — the folds' pace (Collapse) */
const GROW_MS = 240;

/**
 * #540 (user: "the next graph suddenly jumps down or up"): a box whose
 * height follows its content smoothly. The content is measured as it
 * changes — another view, rows arriving — and the box eases from the old
 * height to the new one, clipping only while it moves; the global
 * reduced-motion rule collapses the transition. Before the first
 * measurement (and where nothing measures, as in tests) it is a plain
 * auto-height box.
 */
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
        // grow or shrink from where it stands; nothing spills over the card below meanwhile
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
