// a touch-drag hides the keyboard on SEARCH fields only (#312): multi-field forms keep it while scrolling between inputs
// touchmove, not scroll: a focus-driven auto-scroll fires scroll events but never touchmove
// Enter on a field that goes nowhere hides it (Shift+Enter and IME pass); coarse-pointer only, desktop is untouched

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

  const onTouchStart = (e: TouchEvent) => {
    const t = e.touches[0];
    start = t ? { x: t.clientX, y: t.clientY } : null;
  };

  const onTouchMove = (e: TouchEvent) => {
    if (!start || !coarsePointer()) return;
    const active = document.activeElement;
    if (!isEditable(active)) return;
    if (!active.closest('[data-search-dismiss]')) return;
    // a drag inside the focused field is caret/selection work — and
    // scrolling a long note must not close its own keyboard
    if (e.target instanceof Node && active.contains(e.target)) return;
    const t = e.touches[0];
    if (!t) return;
    if (Math.abs(t.clientX - start.x) < DRAG_THRESHOLD_PX && Math.abs(t.clientY - start.y) < DRAG_THRESHOLD_PX) return;
    active.blur();
    start = null;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter' || e.isComposing) return;
    if (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    if (!coarsePointer()) return;
    if (isEditable(e.target)) e.target.blur();
  };

  // capture: element-level stopPropagation (color wheel, drag blockers)
  // must not be able to starve the dismissal
  window.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
  window.addEventListener('touchmove', onTouchMove, { passive: true, capture: true });
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('touchstart', onTouchStart, true);
    window.removeEventListener('touchmove', onTouchMove, true);
    window.removeEventListener('keydown', onKeyDown);
  };
}
