/**
 * Touch affordance: resting a finger on any .m-tap element flashes its
 * pressed state, and a scroll taking over interrupts the animation —
 * the "almost clicked" hint that marks what is tappable. Browsers
 * suppress :active during scroll-intent on touch, so this is driven by
 * pointer events instead (mouse keeps plain :active from CSS).
 */
export function initPressFeedback(): void {
  let pressed: HTMLElement | null = null;
  let timer: number | undefined;

  const clear = () => {
    clearTimeout(timer);
    if (pressed) delete pressed.dataset.pressed;
    pressed = null;
  };

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (e.pointerType === 'mouse') return; // CSS :active covers mice
      const target = (e.target as Element).closest?.('.m-tap');
      if (!(target instanceof HTMLElement)) return;
      clear();
      // tiny delay: a fast flick should scroll without flashing every row;
      // a finger that actually rests gets the pressed look
      timer = window.setTimeout(() => {
        pressed = target;
        target.dataset.pressed = '';
      }, 60);
    },
    { passive: true },
  );
  document.addEventListener('pointerup', clear, { passive: true });
  // the browser fires pointercancel the moment scrolling takes the
  // gesture — exactly the "interrupted press" moment
  document.addEventListener('pointercancel', clear, { passive: true });
  document.addEventListener('scroll', clear, { capture: true, passive: true });
}
