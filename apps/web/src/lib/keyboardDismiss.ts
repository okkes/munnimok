/**
 * Mobile keyboard dismissal (user requests 2026-08-05):
 *
 * 1. A touch-drag anywhere — screen or sheet content — hides the
 *    on-screen keyboard. Browsers only blur when a tap lands on another
 *    focusable, so scrolling a list under an open keyboard left it
 *    standing. Listening to touchmove (not scroll) keeps focus-driven
 *    auto-scrolls from closing the keyboard the moment a field is
 *    tapped: the browser's reveal scroll fires scroll events but never
 *    touchmove. #312: the hide waits for the FINGER TO LIFT — where the
 *    viewport resizes with the keyboard, hiding mid-drag reflowed the
 *    sheet under the moving finger.
 *
 * 2. Enter on a field that goes nowhere (search-as-you-type, notes)
 *    hides the keyboard — nothing submits, but reaching for Enter is
 *    muscle memory, so honor it by closing the keyboard. Shift+Enter
 *    still inserts newlines in textareas for hardware keyboards; IME
 *    confirmations (isComposing) pass through untouched.
 *
 * Both behaviors are coarse-pointer only — desktop pointer users keep
 * the exact current behavior (Enter shortcuts, focus retention).
 */

/** far enough that a wobbly tap never reads as a scroll */
const DRAG_THRESHOLD_PX = 12;

/** input types that summon NO on-screen keyboard (kept in step with
 *  AppLayout's tab-bar heuristic) — blurring a checkbox on drag would
 *  only fight its toggle */
const KEYBOARDLESS_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'file', 'color']);

const isEditable = (el: EventTarget | null): el is HTMLElement =>
  el instanceof HTMLElement &&
  ((el.tagName === 'INPUT' && !KEYBOARDLESS_INPUTS.has((el as HTMLInputElement).type)) ||
    el.tagName === 'TEXTAREA' ||
    el.isContentEditable);

const coarsePointer = (): boolean => window.matchMedia?.('(pointer: coarse)')?.matches ?? false;

export function installKeyboardDismiss(): () => void {
  let start: { x: number; y: number } | null = null;
  // #312 (user): the blur is DECIDED mid-drag but EXECUTED at gesture
  // end. On Android and in the native shells the webview RESIZES when
  // the keyboard hides — blurring 12px into the drag landed that reflow
  // under the moving finger ("the moment I touch the screen to scroll,
  // the screen jumps"). Deferred, the scroll runs its course with the
  // keyboard still up; on lift the keyboard slides away and the sheet
  // settles with no gesture left to fight.
  let pendingBlur: HTMLElement | null = null;

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    start = t ? { x: t.clientX, y: t.clientY } : null;
    pendingBlur = null;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!start || !coarsePointer()) return;
    const active = document.activeElement;
    if (!isEditable(active)) return;
    // a drag inside the focused field is caret/selection work — and
    // scrolling a long note must not close its own keyboard
    if (e.target instanceof Node && active.contains(e.target)) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - start.x) < DRAG_THRESHOLD_PX && Math.abs(t.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    pendingBlur = active;
    start = null; // one decision per gesture
  };

  const onTouchEnd = () => {
    // only the field the gesture judged — a focus that moved on its own
    // mid-gesture is not ours to tear down
    if (pendingBlur && document.activeElement === pendingBlur) pendingBlur.blur();
    pendingBlur = null;
    start = null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    // modified Enter keeps its meaning (Shift+Enter = newline on a
    // hardware keyboard attached to a tablet)
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!coarsePointer()) return;
    if (isEditable(e.target)) e.target.blur();
  };

  // capture: element-level stopPropagation (color wheel, drag blockers)
  // must not be able to starve the dismissal
  window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  window.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
  window.addEventListener('touchcancel', onTouchEnd, { passive: true, capture: true });
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('touchstart', onTouchStart, true);
    window.removeEventListener('touchmove', onTouchMove, true);
    window.removeEventListener('touchend', onTouchEnd, true);
    window.removeEventListener('touchcancel', onTouchEnd, true);
    window.removeEventListener('keydown', onKeyDown);
  };
}
