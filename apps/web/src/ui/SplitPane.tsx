import type { ReactNode } from 'react';
import { useLgViewport } from '@/lib/viewport';

/**
 * Master–detail panes (redesign §4.2): a detail screen wraps itself and
 * names its list; at lg the list renders beside the detail instead of
 * being covered by it. Below lg (and in tests) the detail fills the
 * screen exactly as before — routes, deep links and back are untouched.
 */
export function SplitPane({ list, children }: Readonly<{ list: ReactNode; children: ReactNode }>) {
  const panes = useLgViewport();
  if (!panes) return <>{children}</>;
  return (
    <div className="flex h-full min-h-0" data-testid="split-pane">
      <div className="h-full w-[42%] min-w-0 max-w-[440px] border-r border-line">{list}</div>
      <div className="h-full min-w-0 flex-1">{children}</div>
    </div>
  );
}
