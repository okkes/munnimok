import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { Drawer } from 'vaul';

/** the three sheet heights; per-pixel values stay out of call sites */
export type SheetSize = 'compact' | 'form' | 'tall';
const SIZE_PX: Record<SheetSize, number> = { compact: 320, form: 440, tall: 600 };

// desktop ruling (redesign §4.3): sheets become right-side panels at lg,
// so forms stop covering the context they edit. One media query, shared.
const PANEL_QUERY = '(min-width: 1024px)';
const subscribePanel = (listener: () => void) => {
  const mql = typeof window === 'undefined' ? undefined : window.matchMedia?.(PANEL_QUERY);
  mql?.addEventListener?.('change', listener);
  return () => mql?.removeEventListener?.('change', listener);
};
const readPanel = () => (typeof window === 'undefined' ? false : (window.matchMedia?.(PANEL_QUERY)?.matches ?? false));
const usePanelMode = (): boolean => useSyncExternalStore(subscribePanel, readPanel, () => false);

// Android resizes the layout viewport itself for the keyboard (see the
// interactive-widget viewport meta) — vaul's own input repositioning on
// top of that left the sheet squeezed after the keyboard closed without
// a blur (tap outside / auto-hide). iOS still needs vaul's handling.
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

// ── sheet stack ──────────────────────────────────────────────────────────
// Only the TOP sheet may dismiss. Without this, opening a picker sheet on
// top of a form sheet made every tap inside the picker count as an
// outside-click on the form — which silently cancelled the whole flow
// (the recurring-create bug). Registering automatically beats requiring
// every caller to remember a `locked` prop.
let nextSheetId = 0;
let sheetStack: number[] = [];
const stackListeners = new Set<() => void>();
const pendingRemovals = new Map<number, ReturnType<typeof setTimeout>>();
const notifyStack = () => stackListeners.forEach((listener) => listener());
const subscribeStack = (listener: () => void) => {
  stackListeners.add(listener);
  return () => stackListeners.delete(listener);
};
const topOfStack = () => sheetStack.at(-1) ?? -1;

function pushSheet(id: number) {
  const pending = pendingRemovals.get(id);
  if (pending) {
    clearTimeout(pending);
    pendingRemovals.delete(id);
  }
  sheetStack = [...sheetStack.filter((entry) => entry !== id), id];
  notifyStack();
}

function popSheetSoon(id: number) {
  // keep the slot through the exit animation: a tap while the child is
  // sliding out must not count as an outside-click on the parent below
  pendingRemovals.set(
    id,
    setTimeout(() => {
      pendingRemovals.delete(id);
      sheetStack = sheetStack.filter((entry) => entry !== id);
      notifyStack();
    }, 500),
  );
}

/** true when this sheet is the top of the open-sheet stack (or closed) */
function useSheetStack(open: boolean): boolean {
  const idRef = useRef(-1);
  if (idRef.current === -1) idRef.current = nextSheetId++;
  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    pushSheet(id);
    return () => popSheetSoon(id);
  }, [open]);
  const top = useSyncExternalStore(subscribeStack, topOfStack);
  return !open || top === idRef.current;
}

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
  /** named height — use this for every new sheet */
  size?: SheetSize;
  /** escape hatch for truly odd content; prefer `size` */
  height?: number;
}

/**
 * The one shared bottom sheet for the whole app: swipe-to-dismiss and
 * background scroll locking come from vaul; stacked sheets lock their
 * parents automatically. Never build inline overlays.
 */
export function Sheet({ open, onOpenChange, title, children, size, height }: Readonly<SheetProps>) {
  const fixedHeight = height ?? (size ? SIZE_PX[size] : undefined);
  const isLocked = !useSheetStack(open);
  const panel = usePanelMode();
  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => (isLocked && !next ? undefined : onOpenChange(next))}
      dismissible={!isLocked}
      repositionInputs={!IS_ANDROID}
      direction={panel ? 'right' : 'bottom'}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content
          className={
            panel
              ? 'fixed inset-y-0 right-0 z-50 flex h-full w-[420px] max-w-[92vw] flex-col rounded-l-[20px] bg-bg outline-none'
              : 'fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-[560px] flex-col rounded-t-[20px] bg-bg outline-none'
          }
          style={!panel && fixedHeight ? { height: fixedHeight } : undefined}
        >
          {/* full-height drag zone across the title area (panels have no handle) */}
          <div className="shrink-0 cursor-grab pt-2.5 pb-1">
            {!panel && <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />}
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
