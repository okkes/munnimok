// iOS (#129): WebKit scrolls a focused field into view while the viewport is still full height, then the keyboard shrinks it
// and nothing re-scrolls, burying the field (Android resizes first); one late pass after a resize or focus hop fixes it
// viewport injected for tests (happy-dom has no visualViewport)

const isEditable = (el: EventTarget | null): el is HTMLElement =>
  el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);

const FOCUS_SETTLE_MS = 300;
const MARGIN_PX = 8;

interface ViewportLike {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener: (type: 'resize', listener: () => void) => void;
  removeEventListener: (type: 'resize', listener: () => void) => void;
}

export function installKeyboardReveal(viewport: ViewportLike | null = globalThis.visualViewport): () => void {
  if (!viewport) return () => {};
  let settle: ReturnType<typeof setTimeout> | undefined;

  const reveal = () => {
    const active = document.activeElement;
    if (!isEditable(active)) return;
    const rect = active.getBoundingClientRect();
    // the visible band in layout coordinates: the visual viewport can
    // both shrink (keyboard) and shift (iOS pins it below the URL bar)
    const visibleTop = viewport.offsetTop;
    const visibleBottom = viewport.offsetTop + viewport.height;
    if (rect.bottom > visibleBottom - MARGIN_PX || rect.top < visibleTop) {
      active.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  const schedule = () => {
    clearTimeout(settle);
    settle = setTimeout(reveal, FOCUS_SETTLE_MS);
  };

  // keyboard shows/hides → the viewport resizes → one settled pass;
  // focus hopping between fields under an OPEN keyboard never resizes,
  // so focusin schedules its own pass
  viewport.addEventListener('resize', schedule);
  window.addEventListener('focusin', schedule);
  return () => {
    clearTimeout(settle);
    viewport.removeEventListener('resize', schedule);
    window.removeEventListener('focusin', schedule);
  };
}
