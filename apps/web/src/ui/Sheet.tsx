import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Sheet as ModalSheet, type SheetRef } from 'react-modal-sheet';
// desktop ruling (2026-07-17, replaces §4.3's right panel the user
// disliked): at lg a sheet renders as a centered dialog — the familiar
// desktop shape, with the page still visible around it
import { useLgViewport as usePanelMode } from '@/lib/viewport';
import { isNativeApp } from '@/lib/platform';

/** the three sheet heights; per-pixel values stay out of call sites */
export type SheetSize = 'compact' | 'form' | 'tall';
const SIZE_PX: Record<SheetSize, number> = { compact: 320, form: 440, tall: 600 };

// framer-motion animates in real wall-clock time even in jsdom (vaul's
// CSS transitions never ran there) — under parallel test load those
// ~300ms opens/closes eat waitFor budgets at random. Instant in tests.
const IS_TEST = import.meta.env.MODE === 'test';

// Keyboard avoidance (translating the sheet up by the keyboard height)
// is only for environments where the viewport does NOT resize for the
// keyboard — plain iOS Safari/PWA. Everywhere the viewport resizes it
// stacks on top and strands sheets past the status bar with a
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
  syncCoveredStyles();
}
function popVisual(id: number) {
  visualStack = visualStack.filter((entry) => entry !== id);
  notifyStack();
  syncCoveredStyles();
}

/** true while any sheet is open — global gestures (edge-swipe back) must stand down */
export const hasOpenSheet = (): boolean => visualStack.length > 0;

// every open sheet registers its close callback; the Mina tutorial (and
// only flows like it) dismisses leftovers before moving to a step whose
// target lives outside any sheet
const sheetClosers = new Map<number, () => void>();
export function closeAllSheets(): void {
  for (const close of [...sheetClosers.values()].reverse()) close();
}

// ── drag-linked zoom (imperative) ────────────────────────────────────────
// Covered parents recede; while the TOP sheet is dragged toward dismissal
// they grow back IN STEP with the finger, both directions. This is driven
// by writing styles straight onto registered elements: routing per-frame
// drag progress through React re-rendered every stacked sheet per
// pointermove and made the whole thing stutter (2026-07-24 user feedback).
const COVERED_SCALE = 0.92;
const COVERED_OPACITY = 0.55;
const SETTLE_TRANSITION = 'transform 300ms ease-out, opacity 300ms ease-out';
const coveredEls = new Map<number, HTMLElement>();

const isCoveredNow = (id: number) => visualStack.includes(id) && visualStack.at(-1) !== id;

/** settled state: full covered recede (or none), animated */
function syncCoveredStyles() {
  for (const [id, el] of coveredEls) {
    el.style.transition = SETTLE_TRANSITION;
    if (isCoveredNow(id)) {
      el.style.transform = `scale(${COVERED_SCALE})`;
      el.style.opacity = `${COVERED_OPACITY}`;
    } else {
      el.style.transform = '';
      el.style.opacity = '';
    }
  }
}

/** mid-drag: parents TRACK the finger — no transition, interpolated */
function applyDragToCovered(pct: number) {
  const clamped = Math.min(1, Math.max(0, pct));
  for (const [id, el] of coveredEls) {
    if (!isCoveredNow(id)) continue;
    el.style.transition = 'none';
    el.style.transform = `scale(${COVERED_SCALE + (1 - COVERED_SCALE) * clamped})`;
    el.style.opacity = `${COVERED_OPACITY + (1 - COVERED_OPACITY) * clamped}`;
  }
}

function registerCoveredEl(id: number, el: HTMLElement | null) {
  if (el) {
    coveredEls.set(id, el);
    syncCoveredStyles();
  } else {
    coveredEls.delete(id);
  }
}

/** stack facts for one sheet: dismissal lock + visual depth */
function useSheetStack(open: boolean): { id: number; isLocked: boolean; depth: number } {
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
  const visualIndex = visualStack.indexOf(idRef.current);
  return {
    id: idRef.current,
    isLocked: open && top !== idRef.current,
    /** how many sheets sit BELOW this one (0 = root sheet) */
    depth: Math.max(0, visualIndex),
  };
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

// ── desktop grow-from-source ─────────────────────────────────────────────
// The dialog grows out of where the user clicked and shrinks back there on
// close (user request 2026-07-24) — an instant popup felt wrong. The last
// pointerdown is the best available proxy for "the source place".
let lastPointer = { x: 0, y: 0 };
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { capture: true, passive: true },
  );
}
const PANEL_MS = 220;

interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
  /** named height — use this for every new sheet */
  size?: SheetSize;
  /** escape hatch for truly odd content; prefer `size` */
  height?: number;
  /** pinned below the scroll area (save/confirm rows) — never `position:
   *  sticky` inside the scrollport: the keyboard translation and
   *  safe-area padding sent it drifting over the content (user ss) */
  footer?: ReactNode;
}

interface DesktopDialogProps {
  id: number;
  open: boolean;
  isLocked: boolean;
  fixedHeight: number | undefined;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  onOpenChange: (open: boolean) => void;
}

/** desktop (2026-07-18 fix): a plain centered dialog — vaul's drawer
 *  transforms fought the centered layout and pinned it to the top */
function DesktopDialog({ id, open, isLocked, fixedHeight, title, children, footer, onOpenChange }: Readonly<DesktopDialogProps>) {
  // enter/exit: grow from the click point, shrink back to it
  const [phase, setPhase] = useState<'closed' | 'hidden' | 'open'>('closed');
  const originRef = useRef({ x: 0, y: 0 });
  useEffect(() => {
    if (open) {
      originRef.current = { ...lastPointer };
      setPhase('hidden'); // mounted at the source point…
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')));
      return () => cancelAnimationFrame(raf);
    }
    setPhase((prev) => (prev === 'closed' ? 'closed' : 'hidden')); // …shrink back
    const timer = setTimeout(() => setPhase('closed'), PANEL_MS);
    return () => clearTimeout(timer);
  }, [open]);

  // ESC closes the TOP desktop dialog only
  useEffect(() => {
    if (!open || isLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isLocked, onOpenChange]);

  if (!open && phase === 'closed') return null;
  const hidden = phase !== 'open';
  const from = originRef.current;
  const dx = from.x - window.innerWidth / 2;
  const dy = from.y - window.innerHeight / 2;
  // PORTALED to body (user ss): rendered inside the master-detail pane,
  // the pane's slide transform turned `fixed` into pane-relative — the
  // overlay grayed only half the app, the list beside it stayed
  // clickable, and the grow-from-click origin missed by the pane offset.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        aria-label="close"
        tabIndex={-1}
        onClick={() => !isLocked && onOpenChange(false)}
        className="absolute inset-0 cursor-default border-none bg-black/40"
        style={{ opacity: hidden ? 0 : 1, transition: `opacity ${PANEL_MS}ms ease-out` }}
      />
      {/* a real <dialog> (a11y): UA border/padding/color neutralized */}
      <dialog
        open
        aria-modal="true"
        ref={(el) => registerCoveredEl(id, el)}
        className="relative z-10 m-0 flex w-[480px] max-w-[92vw] flex-col rounded-[20px] border-none bg-bg p-0 text-ink shadow-2xl outline-none"
        style={{
          height: fixedHeight,
          maxHeight: '85dvh',
          // grow from the source, shrink back to it — the covered-parent
          // recede writes to the same properties, so hand them over only
          // while entering/exiting
          ...(hidden || !isCoveredNow(id)
            ? {
                transform: hidden ? `translate(${dx}px, ${dy}px) scale(0.2)` : undefined,
                opacity: hidden ? 0 : undefined,
                transition: `transform ${PANEL_MS}ms cubic-bezier(0.32, 0.72, 0, 1), opacity ${PANEL_MS}ms ease-out`,
              }
            : {}),
        }}
      >
        {title && <div className="m-h3 shrink-0 px-5 pt-5 pb-1 text-ink">{title}</div>}
        {/* basis auto, not flex-1: with no fixed height this dialog is
            auto-height, where WebKit resolves a `flex: 1 1 0%` child with
            no content minimum to zero (the iOS bottom-sheet bug) */}
        <div className="overflow-y-auto overscroll-contain px-5 pt-2 pb-5" style={{ flex: '1 1 auto', minHeight: 0 }}>
          {children}
        </div>
        {footer && <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-5">{footer}</div>}
      </dialog>
    </div>,
    document.body,
  );
}

/**
 * The one shared bottom sheet for the whole app: swipe-to-dismiss,
 * drag/scroll coordination and background scroll locking come from
 * react-modal-sheet (replaced vaul 2026-07-26 — its gesture capture kept
 * cancelling inputs mid-typing, user report); stacked sheets lock their
 * parents automatically. Never build inline overlays.
 */
export function Sheet({ open, onOpenChange, title, children, size, height, footer }: Readonly<SheetProps>) {
  const requested = height ?? (size ? SIZE_PX[size] : undefined);
  const { id, isLocked, depth } = useSheetStack(open);
  // registered while open so closeAllSheets() can dismiss leftovers
  useEffect(() => {
    if (!open) return;
    sheetClosers.set(id, () => onOpenChange(false));
    return () => void sheetClosers.delete(id);
  }, [open, id, onOpenChange]);
  // stacked sheets step DOWN in height (28px per level, floor 280) so
  // the parent's receded edge stays visible — the depth cue the thin
  // drag bar alone never gave (user request)
  const fixedHeight = requested === undefined ? undefined : Math.max(280, requested - depth * 28);
  const panel = usePanelMode();

  // the whole test corpus was written against vaul's jsdom behavior: a
  // closed sheet STAYED MOUNTED (its exit transition never ran there),
  // and tests observe post-close state through the still-mounted inputs.
  // framer-motion's real unmount-after-exit races those assertions under
  // load — so in tests, once opened, the sheet stays mounted for good.
  const [everOpen, setEverOpen] = useState(false);
  useEffect(() => {
    if (open) setEverOpen(true);
  }, [open]);

  // the sheet's y-progress (1 = resting open, 0 = dismissed) drives the
  // covered parents: they recede in step with the child's slide-in and
  // grow back in step with its drag/dismissal — both directions, every
  // frame, without React re-renders
  const sheetRef = useRef<SheetRef>(null);
  const isLockedRef = useRef(isLocked);
  useEffect(() => {
    isLockedRef.current = isLocked;
  }, [isLocked]);
  // ESC closes the TOP sheet (vaul inherited this from Radix; the lib
  // doesn't do keyboard dismissal itself)
  useEffect(() => {
    if (!open || panel || isLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, panel, isLocked, onOpenChange]);
  useEffect(() => {
    if (!open || panel) return;
    // the ref populates once the portal mounts — subscribe a frame later
    let unsubscribe: (() => void) | undefined;
    const raf = requestAnimationFrame(() => {
      const progress = sheetRef.current?.yProgress;
      if (!progress) return;
      unsubscribe = progress.on('change', (value) => {
        if (isLockedRef.current) return; // only the top sheet drives parents
        if (value >= 0.999) syncCoveredStyles();
        else applyDragToCovered(1 - value);
      });
    });
    return () => {
      cancelAnimationFrame(raf);
      unsubscribe?.();
    };
  }, [open, panel]);

  if (panel) {
    return (
      <DesktopDialog id={id} open={open} isLocked={isLocked} fixedHeight={fixedHeight} title={title} footer={footer} onOpenChange={onOpenChange}>
        {children}
      </DesktopDialog>
    );
  }

  return (
    <ModalSheet
      ref={sheetRef}
      isOpen={IS_TEST ? everOpen : open}
      onClose={() => {
        syncCoveredStyles(); // a settled dismissal ends the drag
        if (!isLocked) onOpenChange(false);
      }}
      onCloseStart={() => {
        syncCoveredStyles();
        // the exiting copy stays mounted through the close animation —
        // taps in that window must fall through to what's underneath,
        // not be swallowed by a ghost whose handlers are about to die
        const ghost = coveredEls.get(id);
        if (ghost) ghost.style.pointerEvents = 'none';
      }}
      detent="content"
      avoidKeyboard={!VIEWPORT_RESIZES}
      disableDismiss={isLocked}
      prefersReducedMotion={IS_TEST}
      unstyled
      // z-50 like the old drawer: the Mina tutorial overlay must still be
      // able to sit above sheets (the lib's default is 9999)
      style={{ zIndex: 50 }}
    >
      <ModalSheet.Backdrop
        className="bg-black/40"
        onTap={() => {
          if (!isLocked) onOpenChange(false);
        }}
        // plain-click fallback (mouse/emulated environments where the
        // tap gesture doesn't materialize); double-firing is a no-op
        onClick={() => {
          if (!isLocked) onOpenChange(false);
        }}
      />
      <ModalSheet.Container className="inset-x-0 mx-auto w-full max-w-[560px] overflow-hidden rounded-t-[20px] bg-bg shadow-[0_-16px_48px_rgba(0,0,0,0.30)] outline-none">
        {/* stacked-sheet depth (user request): a sheet buried under a
            child visibly recedes instead of hiding behind a thin bar —
            and grows back in step with the child's dismissal drag
            (styles written imperatively via registerCoveredEl) */}
        <div
          ref={(el) => registerCoveredEl(id, el)}
          className="flex flex-col"
          // NOT a growing flex item (iOS bug 2026-07-26): detent="content"
          // leaves the container height auto, and `flex: 1 1 0%` overrides
          // `height` for the main axis while min-height:0 removes the
          // content-based minimum — WebKit then resolves this to ZERO and
          // the sheet opens header-only (user ss), where Blink grows it to
          // content anyway. Basis auto + explicit height, every engine.
          style={{ transformOrigin: 'top center', flex: '0 0 auto', height: fixedHeight, maxHeight: '92dvh' }}
          // a pointer landing on an editable must NEVER become a sheet
          // drag (input-cancelled-while-typing, user report). Capture
          // phase: the drag gesture binds natively on the lib's
          // Header/Content elements, so a bubble-phase stop fires too
          // late to keep the pointer stream with the input.
          onPointerDownCapture={(e) => {
            const el = e.target as HTMLElement;
            if (el.closest('input, textarea, select, [contenteditable="true"]')) e.stopPropagation();
          }}
        >
          {/* full-height drag zone across the title area */}
          <ModalSheet.Header className="shrink-0 cursor-grab pt-2.5 pb-1">
            <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
            {title && <div className="m-h3 px-5 pt-3 pb-1 text-ink">{title}</div>}
          </ModalSheet.Header>
          {/* content drags the sheet only at scroll-top or when nothing
              scrolls (the lib's scroll-position coordination — the same
              semantics our hand-rolled touchmove guard gave vaul);
              bottom padding lives INSIDE the scroller because the lib
              writes its keyboard inset onto the scroller's own style */}
          {/* same WebKit rule below: flex-BASIS auto (never 0%) so the
              scrollport is content-sized then grows/shrinks, and the
              lib's `height: 100%` on the scroller is replaced — a
              percentage of a flex-sized parent is indefinite in WebKit */}
          <ModalSheet.Content
            style={{ flex: '1 1 auto', minHeight: 0 }}
            scrollClassName="px-5"
            scrollStyle={{ height: 'auto', flex: '1 1 auto', minHeight: 0 }}
          >
            <div className={footer ? 'pb-2' : 'pb-[max(20px,env(safe-area-inset-bottom))]'}>{children}</div>
          </ModalSheet.Content>
          {/* pinned footer: OUTSIDE the scrollport, so it can never
              drift over the content (the sticky-in-scroll version did,
              user ss) and survives the keyboard translation intact */}
          {footer && (
            <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
              {footer}
            </div>
          )}
        </div>
      </ModalSheet.Container>
    </ModalSheet>
  );
}
