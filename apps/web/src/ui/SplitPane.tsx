import type { ReactNode } from 'react';
import { Outlet, useChildMatches } from '@tanstack/react-router';
import { useLgViewport } from '@/lib/viewport';

/** route-level: the LIST route stays mounted while detail child routes come and go through the Outlet, so a detail opens by
 *  shrinking the list aside (a remount read as a page refresh); below lg a matched detail fills the screen */
export function MasterDetailLayout({ list }: Readonly<{ list: ReactNode }>) {
  const panes = useLgViewport();
  const hasDetail = useChildMatches().length > 0;
  if (!panes) return hasDetail ? <Outlet /> : <>{list}</>;
  return (
    <div className="flex h-full min-h-0" data-testid="split-pane">
      <div
        className={`h-full min-w-0 shrink-0 transition-[width] duration-200 ease-out ${
          hasDetail ? 'w-[46%] max-w-[560px] border-r border-line' : 'w-full'
        }`}
      >
        {list}
      </div>
      <div className="h-full min-w-0 flex-1 overflow-hidden">
        {hasDetail && (
          <div className="m-pane-in h-full">
            <Outlet />
          </div>
        )}
      </div>
    </div>
  );
}
