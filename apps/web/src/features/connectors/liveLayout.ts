// the frame is MEASURED, not styled: the sheet's flex chain gives a child no definite height (WebKit resolves it
// to nothing), and on iOS the keyboard changes what is left on screen without any layout
// the box IS the image, so a tap's fraction of the box is a tap's fraction of the page, with no letterbox to mis-map

export interface FitInput {
  availW: number;
  availH: number;
  frameW: number;
  frameH: number;
}

/** the largest box with the frame's aspect inside the room, or null when there is no room to measure (tests, a hidden sheet) */
export function fitFrame({ availW, availH, frameW, frameH }: FitInput): { width: number; height: number } | null {
  if (!Number.isFinite(frameW) || frameW <= 0 || !Number.isFinite(frameH) || frameH <= 0) return null;
  const scale = Math.min(availW / frameW, availH / frameH);
  if (!Number.isFinite(scale) || scale <= 0) return null;
  return { width: Math.floor(frameW * scale), height: Math.floor(frameH * scale) };
}

// 0 where the viewport resizes for the keyboard (Android, the native shells); on iOS Safari and the PWA only the
// visual viewport shrinks, and this is the difference
export function keyboardInset(win: Pick<Window, 'innerHeight' | 'visualViewport'>): number {
  const vv = win.visualViewport;
  if (!vv) return 0;
  return Math.max(0, Math.round(win.innerHeight - vv.height - vv.offsetTop));
}

export function nearestScroller(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/** a down and an up this close together are one tap — a finger's wobble must not become a drag the party's page reads as a scroll */
export const TAP_SLOP = 0.03;

export const isTap = (down: { x: number; y: number }, up: { x: number; y: number }): boolean =>
  Math.hypot(up.x - down.x, up.y - down.y) < TAP_SLOP;
