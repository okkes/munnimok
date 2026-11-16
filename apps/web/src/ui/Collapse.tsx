import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

// children stay mounted through the closing transition so the fold has something to shrink, then unmount:
// tests see closed sections as absent
export function Collapse({ open, children }: Readonly<{ open: boolean; children: ReactNode }>) {
  const [mounted, setMounted] = useState(open);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (open && !mounted) setMounted(true); // render-time, so opening never lags a frame
  useEffect(() => {
    if (open || !mounted) return;
    closeTimer.current = setTimeout(() => setMounted(false), 240);
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    };
  }, [open, mounted]);

  return (
    <div
      className="grid transition-[grid-template-rows] duration-200 ease-out"
      style={{ gridTemplateRows: open ? '1fr' : '0fr' }}
    >
      <div className="min-h-0 overflow-hidden">{mounted ? children : null}</div>
    </div>
  );
}
