/** touch feedback on .m-tap: browsers suppress :active during scroll-intent on touch, so pointer events drive it */
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
      const raw = e.target as Element;
      // touch pointers capture implicitly; a long-press context menu (copy-link on an <a>) swallowed pointerup and the
      // element then kept capturing later touches, so capture is dropped up front
      if (raw instanceof HTMLElement && raw.hasPointerCapture?.(e.pointerId)) {
        raw.releasePointerCapture(e.pointerId);
      }
      const target = raw.closest?.('.m-tap');
      if (!(target instanceof HTMLElement)) return;
      clear();
      // a short delay so a fast flick scrolls without flashing every row
      timer = window.setTimeout(() => {
        pressed = target;
        target.dataset.pressed = '';
      }, 60);
    },
    { passive: true },
  );
  document.addEventListener('pointerup', clear, { passive: true });
  document.addEventListener('pointercancel', clear, { passive: true });
  document.addEventListener('scroll', clear, { capture: true, passive: true });
  // a context menu or an app switch (store login browser) suppresses pointerup: the pressed look must not outlive them
  document.addEventListener('contextmenu', clear, { capture: true });
  document.addEventListener('visibilitychange', clear);
}
