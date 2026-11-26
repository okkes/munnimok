import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { AutoHeight } from './AutoHeight';

/** how long a view takes to cross the box — the height change's pace, so both land together */
const SLIDE_MS = 260;
/** the room between the leaving view and the arriving one, so their edges never touch */
const GAP = '24px';
// a test asks right after a tap whether the old view is gone: it must not linger for the length of an animation
const IS_TEST = import.meta.env.MODE === 'test';

interface Leaving {
  key: string;
  node: ReactNode;
  /** the new view sits further right in its tab row, so the old one leaves to the left */
  toLeft: boolean;
}

const stillMotion = (): boolean =>
  IS_TEST || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const shift = (toLeft: boolean, entering: boolean): CSSProperties =>
  ({ '--m-slide-x': `calc(${toLeft === entering ? '100%' : '-100%'} ${toLeft === entering ? '+' : '-'} ${GAP})` }) as CSSProperties;

/** #540: one view at a time. A switch scrolls the old view out to one side while the new one comes in from the other —
 *  the side follows the tabs' order — and the box eases to the new view's height, so what lies under it glides.
 *  `index` is the view's place in its tab row; `viewKey` names the view. */
export function SlideSwitch({
  viewKey,
  index,
  children,
  className,
  testId,
  still = stillMotion(),
}: Readonly<{
  viewKey: string;
  index: number;
  children: ReactNode;
  className?: string;
  testId?: string;
  /** the new view stands at once, nothing slides: reduced motion, and the tests of the screens that use it */
  still?: boolean;
}>) {
  const [shown, setShown] = useState({ key: viewKey, index });
  const [leaving, setLeaving] = useState<Leaving | null>(null);
  // what the box showed last, as it stood then: the view that leaves is drawn once more from it
  const last = useRef<ReactNode>(children);
  if (shown.key !== viewKey) {
    setShown({ key: viewKey, index });
    setLeaving(still ? null : { key: shown.key, node: last.current, toLeft: index > shown.index });
  }
  useLayoutEffect(() => {
    last.current = children;
  });
  useEffect(() => {
    if (!leaving) return;
    const done = setTimeout(() => setLeaving(null), SLIDE_MS);
    return () => clearTimeout(done);
  }, [leaving]);

  return (
    <AutoHeight className={className} testId={testId}>
      {/* the clip holds only while a view moves: at rest a chart's focus ring and hover marks may reach past the box */}
      <div className={`relative ${leaving ? 'overflow-x-clip' : ''}`} data-sliding={leaving ? 'true' : undefined}>
        {leaving && (
          <div key={leaving.key} aria-hidden inert className="m-slide-out pointer-events-none absolute inset-x-0 top-0" style={shift(leaving.toLeft, false)}>
            {leaving.node}
          </div>
        )}
        <div key={shown.key} className={leaving ? 'm-slide-in' : undefined} style={leaving ? shift(leaving.toLeft, true) : undefined}>
          {children}
        </div>
      </div>
    </AutoHeight>
  );
}
