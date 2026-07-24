import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { Drawer } from 'vaul';
// desktop ruling (2026-07-17, replaces §4.3's right panel the user
// disliked): at lg a sheet renders as a centered dialog — the familiar
// desktop shape, with the page still visible around it
import { useLgViewport as usePanelMode } from '@/lib/viewport';
import { isNativeApp } from '@/lib/platform';

/** the three sheet heights; per-pixel values stay out of call sites */
export type SheetSize = 'compact' | 'form' | 'tall';
const SIZE_PX: Record<SheetSize, number> = { compact: 320, form: 440, tall: 600 };

// Vaul's own input repositioning (translating the sheet up by the
// keyboard height) is only for environments where the viewport does NOT
// resize for the keyboard — plain iOS Safari. Everywhere the viewport
// resizes it stacks on top and strands sheets past the status bar with a
// keyboard-sized gap at the bottom (user ss 2026-07-19):
//  - Android: the interactive-widget viewport meta resizes the layout
//  - native shells: @capacitor/keyboard resize:"native" shrinks the webview
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const VIEWPORT_RESIZES = IS_ANDROID || isNativeApp();

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
// visual stack: pops IMMEDIATELY on close so the parent un-shrinks in
// step with the child's exit animation (the dismissal stack keeps its
// grace period — an outside tap during the exit must not hit the parent)
let visualStack: number[] = [];
const visualOf = () => visualStack.join(',');
function pushVisual(id: number) {
  visualStack = [...visualStack.filter((entry) => entry !== id), id];
  notifyStack();
}
function popVisual(id: number) {
  visualStack = visualStack.filter((entry) => entry !== id);
  notifyStack();
}

/** true while any sheet is open — global gestures (edge-swipe back) must stand down */
export const hasOpenSheet = (): boolean => visualStack.length > 0;

// drag-linked zoom (user request): while the TOP sheet is dragged toward
// dismissal, every covered parent grows back in step with the finger —
// and shrinks again when the drag retreats. One global progress value is
// enough: only the top sheet can drag.
let topDragPct = 0;
const readDragPct = () => topDragPct;
function setTopDragPct(pct: number) {
  const next = Math.min(1, Math.max(0, pct));
  if (next === topDragPct) return;
  topDragPct = next;
  notifyStack();
}

function pushSheet(id: number) {
  const pending = pendingRemovals.get(id);
  if (pending) {
    clearTimeout(pending);
    pendingRemovals.delete(id);
  }
  sheetStack = [...sheetStack.filter((entry) => entry !== id), id];
  pushVisual(id);
  notifyStack();
}

function popSheetSoon(id: number) {
  popVisual(id); // the parent starts growing back right away
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

/** stack facts for one sheet: dismissal lock + visual depth/covered */
function useSheetStack(open: boolean): { isLocked: boolean; depth: number; covered: boolean; dragPct: number } {
  const idRef = useRef(-1);
  if (idRef.current === -1) idRef.current = nextSheetId++;
  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    pushSheet(id);
    return () => popSheetSoon(id);
  }, [open]);
  const top = useSyncExternalStore(subscribeStack, topOfStack);
  useSyncExternalStore(subscribeStack, visualOf); // re-render on visual changes
  const dragPct = useSyncExternalStore(subscribeStack, readDragPct);
  const visualIndex = visualStack.indexOf(idRef.current);
  return {
    isLocked: open && top !== idRef.current,
    /** how many sheets sit BELOW this one (0 = root sheet) */
    depth: Math.max(0, visualIndex),
    /** a child is visually on top right now */
    covered: open && visualIndex !== -1 && visualIndex < visualStack.length - 1,
    /** how far the sheet ABOVE has been dragged toward dismissal (0..1) */
    dragPct,
  };
}

// the receded-parent look: noticeably smaller than the old 0.97 (user:
// "more drastic"), interpolated back to full size by the child's drag
const COVERED_SCALE = 0.92;
const COVERED_OPACITY = 0.55;
const coveredStyle = (covered: boolean, dragPct: number): CSSProperties | undefined => {
  if (!covered) return undefined;
  const scale = COVERED_SCALE + (1 - COVERED_SCALE) * dragPct;
  const opacity = COVERED_OPACITY + (1 - COVERED_OPACITY) * dragPct;
  return {
    transform: `scale(${scale})`,
    opacity,
    // mid-drag the parent must TRACK the finger, not chase it through a
    // 300ms ease — the transition only smooths the settled states
    transition: dragPct > 0 && dragPct < 1 ? 'none' : 'transform 300ms ease-out, opacity 300ms ease-out',
  };
};

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
  const requested = height ?? (size ? SIZE_PX[size] : undefined);
  const { isLocked, depth, covered, dragPct } = useSheetStack(open);
  // stacked sheets step DOWN in height (28px per level, floor 280) so
  // the parent's receded edge stays visible — the depth cue the thin
  // drag bar alone never gave (user request)
  const fixedHeight = requested === undefined ? undefined : Math.max(280, requested - depth * 28);
  const panel = usePanelMode();

  // ESC closes the TOP desktop dialog only
  useEffect(() => {
    if (!panel || !open || isLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [panel, open, isLocked, onOpenChange]);

  // desktop (2026-07-18 fix): a plain centered dialog — vaul's drawer
  // transforms fought the centered layout and pinned it to the top
  if (panel) {
    if (!open) return null;
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
        <button
          aria-label="close"
          tabIndex={-1}
          onClick={() => !isLocked && onOpenChange(false)}
          className="absolute inset-0 cursor-default border-none bg-black/40"
        />
        {/* a real <dialog> (a11y): UA border/padding/color neutralized */}
        <dialog
          open
          aria-modal="true"
          className="relative z-10 m-0 flex w-[480px] max-w-[92vw] flex-col rounded-[20px] border-none bg-bg p-0 text-ink shadow-2xl outline-none transition-[transform,opacity] duration-300 ease-out"
          style={{ height: fixedHeight, maxHeight: '85dvh', ...coveredStyle(covered, dragPct) }}
        >
          {title && <div className="m-h3 shrink-0 px-5 pt-5 pb-1 text-ink">{title}</div>}
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pt-2 pb-5">{children}</div>
        </dialog>
      </div>
    );
  }

  return (
    <Drawer.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setTopDragPct(0); // a settled dismissal ends the drag
        if (isLocked && !next) return;
        onOpenChange(next);
      }}
      dismissible={!isLocked}
      repositionInputs={!VIEWPORT_RESIZES}
      direction="bottom"
      onDrag={(_event, pct) => {
        // only the top sheet can drag — its progress drives the parents
        if (!isLocked) setTopDragPct(pct);
      }}
      onRelease={(_event, staysOpen) => setTopDragPct(staysOpen ? 0 : 1)}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Drawer.Content
          className="fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-[560px] flex-col overflow-hidden rounded-t-[20px] bg-bg shadow-[0_-16px_48px_rgba(0,0,0,0.30)] outline-none"
          style={fixedHeight ? { height: fixedHeight } : undefined}
        >
          {/* stacked-sheet depth (user request): a sheet buried under a
              child visibly recedes instead of hiding behind a thin bar —
              and grows back in step with the child's dismissal drag */}
          <div
            className="flex min-h-0 flex-1 flex-col transition-[transform,opacity] duration-300 ease-out"
            style={{ transformOrigin: 'top center', ...coveredStyle(covered, dragPct) }}
          >
            {/* full-height drag zone across the title area. touch-none +
                pointer capture: once a drag starts here, the finger may
                wander over scrollable content without the browser
                stealing the gesture (user bug: drags cancelled mid-pull) */}
            <div
              className="shrink-0 cursor-grab touch-none pt-2.5 pb-1"
              onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
            >
              <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
              {title && (
                <Drawer.Title className="m-h3 px-5 pt-3 pb-1 text-ink">{title}</Drawer.Title>
              )}
            </div>
            {/* translateZ: Safari fails to repaint this scroll layer when
                content GROWS inside vaul's translated drawer (user ss:
                dark strips around a freshly added row until any resize);
                promoting it to its own layer keeps paints honest */}
            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(20px,env(safe-area-inset-bottom))]"
              style={{ transform: 'translateZ(0)' }}
            >
              {children}
            </div>
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}
