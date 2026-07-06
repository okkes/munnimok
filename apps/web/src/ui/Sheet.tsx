import type { ReactNode } from 'react';
import { Drawer } from 'vaul';

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
  /** Fixed content height in px; sheets must not resize while open. */
  height?: number;
}

/**
 * The one shared bottom sheet for the whole app: swipe-to-dismiss and
 * background scroll locking come from vaul. Never build inline overlays.
 */
export function Sheet({ open, onOpenChange, title, children, height }: SheetProps) {
  return (
    <Drawer.Root open={open} onOpenChange={onOpenChange}>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[20px] bg-bg outline-none"
          style={height ? { height } : undefined}
        >
          {/* full-height drag zone across the title area */}
          <div className="shrink-0 cursor-grab pt-2.5 pb-1">
            <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
            {title && (
              <Drawer.Title className="m-h3 px-5 pt-3 pb-1 text-ink">{title}</Drawer.Title>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(20px,env(safe-area-inset-bottom))]">
            {children}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
