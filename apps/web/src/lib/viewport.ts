import { useSyncExternalStore } from 'react';

// the one desktop breakpoint (redesign §4), shared so Sheet and SplitPane never disagree about where "desktop" begins
const LG_QUERY = '(min-width: 1024px)';

const subscribeLg = (listener: () => void) => {
  const mql = typeof window === 'undefined' ? undefined : window.matchMedia?.(LG_QUERY);
  mql?.addEventListener?.('change', listener);
  return () => mql?.removeEventListener?.('change', listener);
};
const readLg = () => (typeof window === 'undefined' ? false : (window.matchMedia?.(LG_QUERY)?.matches ?? false));

/** true on lg+ viewports; false during SSR and in unit tests */
export const useLgViewport = (): boolean => useSyncExternalStore(subscribeLg, readLg, () => false);

// reveal scrolls only the NEAREST real scroller: scrollIntoView also scrolls overflow-hidden ancestors and sheared a sheet's
// container; the band respects the visualViewport so a keyboard-shrunk viewport centers against what is on screen
// unlike the reveal walk it does not require overflow to exist yet:
// the caller may be about to CREATE it (iOS keyboard padding)
export function nearestScrollport(el: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

// iOS never resizes the LAYOUT viewport for the keyboard, so a screen scroller has no slack to reveal a bottom field into:
// the nearest scrollport borrows bottom padding equal to the keyboard inset; on Android/native the inset reads ~0, a no-op
let paddedScrollport: { el: HTMLElement; prev: string } | null = null;

export function restoreScrollportPad(): void {
  if (!paddedScrollport) return;
  paddedScrollport.el.style.paddingBottom = paddedScrollport.prev;
  paddedScrollport = null;
}

export function padScrollportForKeyboard(target: HTMLElement): void {
  const vv = window.visualViewport;
  const inset = Math.max(0, window.innerHeight - (vv?.height ?? window.innerHeight));
  if (inset < 40) return; // no keyboard-without-resize in play
  const scroller = nearestScrollport(target);
  if (!scroller) return;
  if (paddedScrollport && paddedScrollport.el !== scroller) restoreScrollportPad();
  paddedScrollport ??= { el: scroller, prev: scroller.style.paddingBottom };
  scroller.style.paddingBottom = `${inset + 16}px`;
}

// #136 r2: a row scrolled out of a sheet's inner list keeps window-plausible coordinates while clipped invisible,
// which let the tutorial glow paint over the wrong spot
export function isClippedFromView(el: HTMLElement, topPad = 70, bottomPad = 96): boolean {
  const r = el.getBoundingClientRect();
  if (r.width === 0) return false;
  if (r.top < topPad || r.bottom > window.innerHeight - bottomPad) return true;
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 4) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        const box = node.getBoundingClientRect();
        return r.top < box.top - 2 || r.bottom > box.bottom + 2;
      }
    }
    node = node.parentElement;
  }
  return false;
}

export function revealInScroller(el: HTMLElement): void {
  const vv = window.visualViewport;
  const viewTop = vv?.offsetTop ?? 0;
  const viewBottom = viewTop + (vv?.height ?? window.innerHeight);
  let node: HTMLElement | null = el.parentElement;
  while (node && node !== document.body) {
    if (node.scrollHeight > node.clientHeight + 4) {
      const overflowY = getComputedStyle(node).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll') {
        const box = node.getBoundingClientRect();
        const bandTop = Math.max(box.top, viewTop);
        const bandBottom = Math.min(box.bottom, viewBottom);
        const target = el.getBoundingClientRect();
        const delta = target.top + target.height / 2 - (bandTop + bandBottom) / 2;
        if (bandBottom > bandTop && Math.abs(delta) > 8) {
          node.scrollTo({ top: node.scrollTop + delta, behavior: 'smooth' });
        }
        return; // nearest scroller only — never shear outer containers
      }
    }
    node = node.parentElement;
  }
}
