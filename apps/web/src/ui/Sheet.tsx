import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { Sheet as ModalSheet, type SheetRef } from 'react-modal-sheet';
import { useLang } from '@/i18n';
import { isMinaSheetGuarded } from '@/features/mina/lock';
// desktop ruling: at lg a sheet renders as a centered dialog, with the page still visible around it
import { useLgViewport as usePanelMode } from '@/lib/viewport';
import { isIOS, isNativeApp } from '@/lib/platform';
import { Button } from './Button';

/** `full` is the whole screen bar the status bar (the streamed login needs every pixel); on desktop the dialog's ceiling */
export type SheetSize = 'compact' | 'form' | 'tall' | 'full';
const SIZE_PX: Record<Exclude<SheetSize, 'full'>, number> = { compact: 320, form: 440, tall: 600 };
const FULL_HEIGHT = 'calc(100dvh - env(safe-area-inset-top, 0px) - 12px)';
const FULL_DIALOG = 'min(92dvh, 1000px)';

function dialogHeights(full: boolean | undefined, steady: boolean | undefined, fixedHeight: number | undefined): { height: string | number; maxHeight: string } {
  if (full) return { height: FULL_DIALOG, maxHeight: FULL_DIALOG };
  return { height: steady && fixedHeight !== undefined ? fixedHeight : 'auto', maxHeight: 'min(85dvh, 900px)' };
}

// framer-motion animates in real time even in jsdom: ~300ms opens/closes eat waitFor budgets
// under parallel load; instant in tests
const IS_TEST = import.meta.env.MODE === 'test';

// keyboard avoidance (translating up by the keyboard height) is only for plain iOS Safari/PWA, where the viewport
// does not resize; elsewhere it stacks on the resize and strands the sheet with a keyboard-sized gap
// Android: interactive-widget viewport meta resizes the layout; native shells: @capacitor/keyboard resize:"native"
const IS_ANDROID = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
const VIEWPORT_RESIZES = IS_ANDROID || isNativeApp();

// #134: iOS keeps native tap-to-focus: the library's iOS scroll lock and keyboard avoidance stalled the caret ~2s
// in WebKit, so iOS opts out of both; AppLayout's settled-viewport reveal takes over inside sheets
// the document itself cannot scroll (fixed app frame), so the lock pinned nothing
const ON_IOS = isIOS();

// focusing a covered field makes WebKit shove scrollTop onto overflow:hidden ancestors ("scroll jail"),
// shearing the content: while an iOS sheet is open, each editable focus zeroes shoved offsets on
// non-scrollers, in the focus beat and after the keyboard lands
let jailGuardUsers = 0;
let removeJailGuard: (() => void) | null = null;

function unshoveFrom(el: HTMLElement | null): void {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (node.scrollTop !== 0) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY !== 'auto' && overflowY !== 'scroll') node.scrollTop = 0;
    }
  }
}

function pushJailGuard(): void {
  jailGuardUsers++;
  if (jailGuardUsers > 1) return;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const onFocusIn = (e: FocusEvent) => {
    const target = e.target;
    if (!(target instanceof HTMLElement) || !target.closest('input, textarea, select, [contenteditable="true"]')) return;
    requestAnimationFrame(() => unshoveFrom(target));
    const timer = setTimeout(() => {
      timers.delete(timer);
      unshoveFrom(target);
    }, 400);
    timers.add(timer);
  };
  document.addEventListener('focusin', onFocusIn);
  removeJailGuard = () => {
    document.removeEventListener('focusin', onFocusIn);
    for (const timer of timers) clearTimeout(timer);
  };
}

function popJailGuard(): void {
  jailGuardUsers = Math.max(0, jailGuardUsers - 1);
  if (jailGuardUsers === 0) {
    removeJailGuard?.();
    removeJailGuard = null;
  }
}

// where true, AppLayout's keyboard reveal stands down inside sheets; false on iOS (#134): AppLayout owns it there
export const SHEET_OWNS_KEYBOARD = !VIEWPORT_RESIZES && !ON_IOS;

// #290: the library's keyboard avoidance may engage only on a coarse primary pointer: desktop Chromium exposes
// navigator.virtualKeyboard keyboard-less and the library reads it as open, scrolling a focused field under the header
// Android/native keep their resize path, iOS its #134 opt-out; evaluated at render so docking a tablet keyboard is honored
export const sheetLibAvoidsKeyboard = (): boolean =>
  !VIEWPORT_RESIZES && !ON_IOS && typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

// only the TOP sheet may dismiss: a picker over a form made every tap inside it an outside-click on the form,
// cancelling the whole flow (recurring-create bug)
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
// the visual stack pops immediately on close so the parent un-shrinks with the child's exit; the dismissal stack
// keeps its grace period so an outside tap during the exit misses the parent
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

// #136: the Mina overlay (z-60) outranks every sheet and pierced those stacked above its anchor:
// the tutorial stands its glow down when this says no
export function elementOnTopLayer(el: HTMLElement): boolean {
  if (visualStack.length === 0) return true;
  const topEl = coveredEls.get(visualStack.at(-1)!);
  if (!topEl) return true; // top sheet not measurable yet — don't flicker
  return topEl.contains(el);
}

// every open sheet registers its close callback so the Mina tutorial can dismiss leftovers
// before a step whose target is outside any sheet
const sheetClosers = new Map<number, () => void>();
export function closeAllSheets(): void {
  for (const close of [...sheetClosers.values()].reverse()) close();
}

// covered parents recede, and grow back in step with a dragged top sheet, via styles written straight onto elements:
// routing per-frame drag progress through React re-rendered every stacked sheet and stuttered
const COVERED_SCALE = 0.92;
const COVERED_OPACITY = 0.55;
const SETTLE_TRANSITION = 'transform 300ms ease-out, opacity 300ms ease-out';
const coveredEls = new Map<number, HTMLElement>();

const isCoveredNow = (id: number) => visualStack.includes(id) && visualStack.at(-1) !== id;

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
  popVisual(id);
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

// the dialog grows out of where the user pressed and shrinks back into it; the last pointerdown is the best proxy for the source
interface Point {
  x: number;
  y: number;
}
let lastPress: (Point & { at: number }) | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (e) => {
      lastPress = { x: e.clientX, y: e.clientY, at: performance.now() };
    },
    { capture: true, passive: true },
  );
}
export const PANEL_MS = 220;
/** how long a press still names the control that opened a dialog; after it the keyboard or the app itself opened it */
export const PRESS_FRESH_MS = 1500;
const PANEL_EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';
const PANEL_FROM_SCALE = 0.1;

/** where an opening dialog comes from: the press that opened it, else the focused control, else nowhere (it grows in place) */
export function openingPoint(now: number = performance.now()): Point | null {
  if (lastPress && now - lastPress.at < PRESS_FRESH_MS) return { x: lastPress.x, y: lastPress.y };
  const focused = document.activeElement;
  if (focused instanceof HTMLElement && focused !== document.body) {
    const box = focused.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }
  return null;
}

/** the panel's transform while it is away: shrunk onto the point it came from */
export function panelAwayTransform(origin: Point | null, viewport: { width: number; height: number }): string {
  const dx = origin ? origin.x - viewport.width / 2 : 0;
  const dy = origin ? origin.y - viewport.height / 2 : 0;
  return `translate(${Math.round(dx)}px, ${Math.round(dy)}px) scale(${PANEL_FROM_SCALE})`;
}

// a sheet its screen removes while it is open (a create form that unmounts on save) has no exit of its own:
// a lifeless copy of the dialog shrinks back in its place. Content that restarts when copied is left alone
export function leaveGhost(layer: HTMLElement, away: string): void {
  if (layer.querySelector('iframe, video, canvas, object, embed')) return;
  const ghost = layer.cloneNode(true) as HTMLElement;
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.pointerEvents = 'none';
  for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>('[id], [data-testid], [data-sheet-body]')]) {
    el.removeAttribute('id');
    delete el.dataset.testid;
    delete el.dataset.sheetBody;
  }
  document.body.appendChild(ghost);
  const timing: KeyframeAnimationOptions = { duration: PANEL_MS, easing: PANEL_EASING, fill: 'forwards' };
  ghost.querySelector<HTMLElement>('[data-sheet-panel]')?.animate?.([{ transform: 'none', opacity: 1 }, { transform: away, opacity: 0 }], timing);
  ghost.querySelector<HTMLElement>('[data-sheet-backdrop]')?.animate?.([{ opacity: 1 }, { opacity: 0 }], { ...timing, easing: 'ease-out' });
  setTimeout(() => ghost.remove(), PANEL_MS);
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
  // pinned below the scroll area; never `position: sticky` in the scrollport:
  // keyboard translation and safe-area padding made it drift over the content
  footer?: ReactNode;
  /** DEPRECATED no-op: content drag is back for every sheet; kept so ~20 call sites don't churn */
  dragHandle?: boolean;
  // unsaved edits: a dismissal gesture (backdrop tap, drag-down, Escape) asks "discard changes?" first;
  // programmatic closes are unaffected
  dirty?: boolean;
  // #203: work in flight: dismissal gestures flash this note instead of closing; the host clears it when the work lands
  busyNote?: string | null;
  /** #311: data-dense sheets may take a wider desktop dialog; the mobile sheet is untouched */
  wide?: boolean;
  // #344: pins the desktop dialog to the requested size: content toggling per keystroke made the auto-height dialog pump;
  // mobile is height-locked either way
  steady?: boolean;
  // the content owns every pointer: the library's drag never arms and the capture guard stands down
  // (its stop at the sheet body killed the streamed page's taps once the keyboard reveal scrolled the sheet)
  // the host offers its own close; backdrop and Escape still dismiss
  dragLock?: boolean;
}

// controls with their own gesture (slider, picker, data-sheet-no-drag) and scrollers not at their top keep it
// #364: a text field does not count: a pull-down from the amount input still closes the sheet
// #446: data-sheet-own-gesture elements bind native listeners; a capture stop at React's root would kill them
export function gestureBelongsToContent(target: HTMLElement, stopAt: HTMLElement): boolean {
  if (target.closest('[data-sheet-own-gesture]')) return false;
  if (target.closest('select, input[type="range"], input[type="color"], [contenteditable="true"], [data-sheet-no-drag]')) return true;
  for (let el: HTMLElement | null = target; el && el !== stopAt; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && el.scrollTop > 0) {
      const overflowY = getComputedStyle(el).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') return true;
    }
  }
  return false;
}

interface DesktopDialogProps {
  id: number;
  open: boolean;
  isLocked: boolean;
  fixedHeight: number | undefined;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  steady?: boolean;
  full?: boolean;
  // a user dismissal request (backdrop/Escape): the owner decides whether it closes, asks about unsaved edits,
  // or is tutorial-locked
  onDismiss: () => void;
}

function DesktopDialog({ id, open, isLocked, fixedHeight, title, children, footer, wide, steady, full, onDismiss }: Readonly<DesktopDialogProps>) {
  const [phase, setPhase] = useState<'closed' | 'hidden' | 'open'>('closed');
  const [origin, setOrigin] = useState<Point | null>(null);
  // the origin is taken in the render that opens the dialog: taken an effect later, the first frame stood on the
  // previous origin (the screen's corner the first time) and the dialog flew in from there
  const [wasOpen, setWasOpen] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setOrigin(openingPoint());
      setPhase('hidden');
    }
  }
  useEffect(() => {
    if (open) {
      const raf = requestAnimationFrame(() => requestAnimationFrame(() => setPhase('open')));
      return () => cancelAnimationFrame(raf);
    }
    setPhase((prev) => (prev === 'closed' ? 'closed' : 'hidden'));
    const timer = setTimeout(() => setPhase('closed'), PANEL_MS);
    return () => clearTimeout(timer);
  }, [open]);

  const layerRef = useRef<HTMLDivElement | null>(null);
  const away = typeof window === 'undefined' ? 'none' : panelAwayTransform(origin, { width: window.innerWidth, height: window.innerHeight });
  const leaving = useRef({ shown: false, away });
  leaving.current = { shown: phase === 'open', away };
  useLayoutEffect(
    () => () => {
      if (layerRef.current && leaving.current.shown && !IS_TEST) leaveGhost(layerRef.current, leaving.current.away);
    },
    [],
  );

  useEffect(() => {
    if (!open || isLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, isLocked, onDismiss]);

  if (!open && phase === 'closed') return null;
  const hidden = phase !== 'open';
  // portaled to body: inside the master-detail pane its slide transform made `fixed` pane-relative
  // (half-grayed app, wrong grow origin)
  return createPortal(
    <div ref={layerRef} className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        aria-label="close"
        tabIndex={-1}
        data-sheet-backdrop=""
        onClick={() => !isLocked && onDismiss()}
        className="absolute inset-0 cursor-default border-none bg-black/40"
        style={{ opacity: hidden ? 0 : 1, transition: `opacity ${PANEL_MS}ms ease-out` }}
      />
      {/* the coming and going live on this wrapper: the dialog's own transform and opacity belong to the covered-parent
          recede, which writes them straight onto the element and wiped an enter or exit written on the same one */}
      <div
        data-sheet-panel=""
        data-testid="sheet-panel"
        className="relative z-10 flex max-w-full"
        style={{
          transform: hidden ? away : 'none',
          opacity: hidden ? 0 : 1,
          transition: `transform ${PANEL_MS}ms ${PANEL_EASING}, opacity ${PANEL_MS}ms ease-out`,
        }}
      >
        {/* #290: wears the sheet container class so AppLayout's keyboard reveal (a pure yank without a keyboard) stands down */}
        <dialog
          open
          aria-modal="true"
          data-sheet-body=""
          data-full={full ? '' : undefined}
          ref={(el) => registerCoveredEl(id, el)}
          // #389/#390: overflow-hidden, or the pinned footer's rectangular background squares off the bottom corners
          className={`react-modal-sheet-container relative m-0 flex ${wide ? 'w-[760px] max-w-[94vw]' : 'w-[480px] max-w-[92vw]'} flex-col overflow-hidden rounded-[20px] border-none bg-bg p-0 text-ink shadow-2xl outline-none`}
          style={{
            // #276: grows with its content (the phone's fixed heights left half-empty dialogs); the size sets a floor,
            // the ceiling is viewport-relative
            // #344: `steady` opts out of the growth: per-keystroke content made the dialog pump between floor and ceiling
            ...dialogHeights(full, steady, fixedHeight),
            minHeight: fixedHeight === undefined ? undefined : Math.round(fixedHeight * 0.6),
          }}
        >
          {title && <div className="m-h3 shrink-0 px-5 pt-5 pb-1 text-ink">{title}</div>}
          {/* flex-auto, not flex-1: basis 0% collapses an auto-height body in WebKit, as on the mobile sheet on iOS */}
          {/* #290: the browser's native focus scroll reveals hidden fields here; scroll-padding gives them air */}
          <div className="min-h-0 flex-auto overflow-y-auto overscroll-contain px-5 pt-2 pb-5 [scroll-padding-block:16px]">{children}</div>
          {footer && <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-5">{footer}</div>}
        </dialog>
      </div>
    </div>,
    document.body,
  );
}

// the one shared bottom sheet; never build inline overlays
// react-modal-sheet replaced vaul: its gesture capture cancelled inputs mid-typing
export function Sheet({ open, onOpenChange, title, children, size, height, footer, dirty, busyNote, wide, steady, dragLock }: Readonly<SheetProps>) {
  const { t } = useLang();
  const full = size === 'full';
  const requested = height ?? (size && size !== 'full' ? SIZE_PX[size] : undefined);
  const { id, isLocked, depth } = useSheetStack(open);
  // user dismissals route through here: the Mina tutorial owns the flow while it runs, and unsaved edits get a "discard?" ask
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [busyFlash, setBusyFlash] = useState(false);
  const busyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashBusy = () => {
    setBusyFlash(true);
    if (busyTimer.current) clearTimeout(busyTimer.current);
    busyTimer.current = setTimeout(() => setBusyFlash(false), 2500);
  };
  // #253: a drag on a dirty sheet completes: it hides, the "discard?" ask shows, Keep editing slides it back;
  // the ref mirror keeps the lib's late animation callbacks from re-arming the ask
  const [hiddenForDiscard, setHiddenForDiscard] = useState(false);
  const hiddenRef = useRef(false);
  const setHidden = (value: boolean) => {
    hiddenRef.current = value;
    setHiddenForDiscard(value);
  };
  useEffect(() => {
    if (!open) {
      setConfirmDiscard(false);
      hiddenRef.current = false;
      setHiddenForDiscard(false);
    }
  }, [open]);
  // #366: edits can settle while the ask is up; the ask is then moot and the hidden sheet must come back,
  // or nothing answers a tap
  useEffect(() => {
    if (dirty || !hiddenRef.current) return;
    setConfirmDiscard(false);
    setHidden(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty]);
  const requestDismiss = () => {
    // the tutorial locks only the ROOT sheet: a nested picker must stay dismissible or the user is trapped one level down
    if (isMinaSheetGuarded() && depth === 0) return;
    if (busyNote) {
      flashBusy();
      return;
    }
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onOpenChange(false);
  };
  useEffect(() => {
    if (!open) return;
    sheetClosers.set(id, () => onOpenChange(false));
    return () => void sheetClosers.delete(id);
  }, [open, id, onOpenChange]);
  // stacked sheets step down in height (28px per level, floor 280) so the parent's receded edge stays visible
  const fixedHeight = requested === undefined ? undefined : Math.max(280, requested - depth * 28);
  const panel = usePanelMode();
  useEffect(() => {
    if (!open || panel || !ON_IOS) return;
    pushJailGuard();
    return () => popJailGuard();
  }, [open, panel]);

  // in tests, once opened the sheet stays mounted: tests observe post-close state through still-mounted
  // inputs (vaul-era behavior), and framer-motion's real unmount-after-exit races those assertions under load
  const [everOpen, setEverOpen] = useState(false);
  useEffect(() => {
    if (open) setEverOpen(true);
  }, [open]);

  // the sheet's y-progress (1 = resting open, 0 = dismissed) drives the covered parents without React re-renders
  const sheetRef = useRef<SheetRef>(null);
  const isLockedRef = useRef(isLocked);
  useEffect(() => {
    isLockedRef.current = isLocked;
  }, [isLocked]);
  // the lib does no keyboard dismissal: Escape closes the TOP sheet
  const requestRef = useRef(requestDismiss);
  requestRef.current = requestDismiss;
  useEffect(() => {
    if (!open || panel || isLocked) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') requestRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, panel, isLocked]);
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

  // the "discard changes?" ask is its own stacked sheet (never window.confirm)
  // #366: rendered while dirty OR while the ask is up: an ask whose subtree vanished mid-answer left the sheet hidden for good
  const discardConfirm = dirty || confirmDiscard ? (
    <Sheet
      open={confirmDiscard}
      onOpenChange={(next) => {
        setConfirmDiscard(next);
        // dismissing the ask itself keeps the edits: the hidden form slides back up (#253)
        if (!next) setHidden(false);
      }}
      title={t('sheet.discardTitle')}
      size="compact"
    >
      <div className="flex flex-col gap-3 pt-1">
        <p className="text-[13px] leading-relaxed text-ink-2">{t('sheet.discardBody')}</p>
        <Button
          data-testid="sheet-keep-editing"
          onClick={() => {
            setConfirmDiscard(false);
            setHidden(false);
          }}
        >
          {t('sheet.keepEditing')}
        </Button>
        <Button
          variant="danger"
          data-testid="sheet-discard"
          onClick={() => {
            // #366: un-hiding here flipped the library's isOpen back to true before the host's close landed, leaving its state
            // machine stuck with the backdrop eating every tap; the `!open` effect resets the hidden flag once the close is real
            setConfirmDiscard(false);
            onOpenChange(false);
          }}
        >
          {t('sheet.discardConfirm')}
        </Button>
      </div>
    </Sheet>
  ) : null;

  const busyBanner =
    busyFlash && busyNote ? (
      <div className="mb-2 rounded-card bg-warning-soft px-3 py-2 text-[12px] text-ink-2" data-testid="sheet-busy-note">
        {busyNote}
      </div>
    ) : null;

  if (panel) {
    return (
      <>
        <DesktopDialog id={id} open={open} isLocked={isLocked} fixedHeight={fixedHeight} title={title} footer={footer} wide={wide} steady={steady} full={full} onDismiss={requestDismiss}>
          {busyBanner}
          {children}
        </DesktopDialog>
        {discardConfirm}
      </>
    );
  }

  return (
    <>
    <ModalSheet
      ref={sheetRef}
      isOpen={IS_TEST ? everOpen : open && !hiddenForDiscard}
      onClose={() => {
        syncCoveredStyles();
        if (!open) return;
        if (isLocked || (isMinaSheetGuarded() && depth === 0)) return;
        // #203: belt for the drag path — disableDismiss already refuses
        if (busyNote) {
          flashBusy();
          return;
        }
        if (dirty) {
          if (!hiddenRef.current) {
            setHidden(true);
            setConfirmDiscard(true);
          }
          return;
        }
        onOpenChange(false);
      }}
      onOpenStart={() => {
        // #366: a body ghosted for a close animation answers taps again when the same element opens once more
        const body = coveredEls.get(id);
        if (body) body.style.pointerEvents = '';
      }}
      onCloseStart={() => {
        syncCoveredStyles();
        // the exiting copy stays mounted through the close animation: taps then must fall through, not hit a ghost
        const ghost = coveredEls.get(id);
        if (ghost) ghost.style.pointerEvents = 'none';
      }}
      detent="content"
      // #134: on iOS both library behaviors stand down: AppLayout reveals, the jail guard keeps chrome straight
      // #290: fine-pointer machines have no on-screen keyboard: the library's virtualKeyboard misfire would scroll
      // every focused field under the header
      avoidKeyboard={sheetLibAvoidsKeyboard()}
      disableScrollLocking={ON_IOS}
      // drag-dismissal is refused by the Mina tutorial (root sheet only) and by #203 in-flight work (springs back,
      // note flashes); dirty forms don't refuse (#253)
      disableDismiss={isLocked || (isMinaSheetGuarded() && depth === 0) || !!busyNote}
      disableDrag={!!dragLock}
      prefersReducedMotion={IS_TEST}
      unstyled
      // z-50 like the old drawer: the Mina tutorial overlay must still sit above sheets (the lib's default is 9999)
      style={{ zIndex: 50 }}
    >
      <ModalSheet.Backdrop
        className="bg-black/40"
        onTap={() => {
          if (!isLocked) requestDismiss();
        }}
        // plain-click fallback where the tap gesture does not materialize (mouse/emulated); double-firing is a no-op
        onClick={() => {
          if (!isLocked) requestDismiss();
        }}
      />
      <ModalSheet.Container className="inset-x-0 mx-auto w-full max-w-[560px] overflow-hidden rounded-t-[20px] bg-bg shadow-[0_-16px_48px_rgba(0,0,0,0.30)] outline-none">
        {/* WebKit: flex-1's basis 0% overrides height here and sheets open header-only; keep basis auto (flex-initial) */}
        <div
          ref={(el) => registerCoveredEl(id, el)}
          data-sheet-body=""
          data-full={full ? '' : undefined}
          className="flex min-h-0 flex-initial flex-col"
          style={{ transformOrigin: 'top center', height: full ? FULL_HEIGHT : fixedHeight, transition: 'height 220ms ease-out' }}
          // a gesture on an editable, a self-handling element or a mid-scroll list must NEVER become a sheet drag
          // (typing cancelled; list and sheet scrolled together); capture phase on both event families:
          // the lib's drag binds pointer events, its scroll coordination touch events
          onPointerDownCapture={(e) => {
            if (!dragLock && gestureBelongsToContent(e.target as HTMLElement, e.currentTarget)) e.stopPropagation();
          }}
          onTouchStartCapture={(e) => {
            if (!dragLock && gestureBelongsToContent(e.target as HTMLElement, e.currentTarget)) e.stopPropagation();
          }}
        >
          <ModalSheet.Header className="shrink-0 cursor-grab pt-2.5 pb-1">
            <div className="mx-auto h-1.5 w-10 rounded-full bg-line" />
            {title && <div className="m-h3 px-5 pt-3 pb-1 text-ink">{title}</div>}
          </ModalSheet.Header>
          {/* bottom padding lives inside the scroller: the lib writes its keyboard inset onto the scroller's own style */}
          {/* flex-auto: same WebKit rule; swaps the lib's `height: 100%` (indefinite in a WebKit flex parent) for flex sizing */}
          <ModalSheet.Content
            className="min-h-0 flex-auto"
            scrollClassName="px-5"
            scrollStyle={{ height: 'auto', flex: '1 1 auto', minHeight: 0 }}
          >
            <div className={footer ? 'pb-2' : 'pb-[max(20px,env(safe-area-inset-bottom))]'}>
              {busyBanner}
              {children}
            </div>
          </ModalSheet.Content>
          {/* pinned footer outside the scrollport: a sticky one drifted over the content and the keyboard translation */}
          {footer && (
            <div className="shrink-0 border-t border-line-2 bg-bg px-5 pt-3 pb-[max(16px,env(safe-area-inset-bottom))]">
              {footer}
            </div>
          )}
        </div>
      </ModalSheet.Container>
    </ModalSheet>
    {discardConfirm}
    </>
  );
}
