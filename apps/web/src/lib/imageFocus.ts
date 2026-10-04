/**
 * The visible part of a picture that is shown "cover"-fitted (#446, user):
 * a frame narrower than the picture crops it, and where it crops is the
 * focus — CSS `object-position`, kept as two percentages. 50/50 is the
 * browser's own default, the centre; 0 is the left/top edge, 100 the
 * right/bottom one. Pure math, so the drag component and the renderers
 * agree by construction.
 */
export interface ImageFocus {
  /** 0..100, the horizontal object-position */
  x: number;
  /** 0..100, the vertical object-position */
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export const CENTER_FOCUS: ImageFocus = { x: 50, y: 50 };

const clampPct = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

/** the CSS `object-position` value for a focus (the centre when none is stored) */
export const focusPosition = (focus?: ImageFocus | null): string => {
  const f = focus ?? CENTER_FOCUS;
  return `${clampPct(f.x)}% ${clampPct(f.y)}%`;
};

/** rounded to a thousandth of a pixel — the axis that fits comes out as
 *  112.00000000000001 minus 112 in floating point, and that is no overhang;
 *  nor is anything under half a pixel, which no drag could pan */
const overhang = (rendered: number, size: number): number => {
  const over = Math.round((rendered - size) * 1000) / 1000;
  return over > 0.5 ? over : 0;
};

/**
 * How far a cover-fitted picture overhangs its frame, per axis, in frame
 * pixels. Zero on the axis that fits exactly — there is nothing to pan
 * there — and zero everywhere while either size is unknown.
 */
export function coverOverflow(natural: Size, frame: Size): { x: number; y: number } {
  if (natural.width <= 0 || natural.height <= 0 || frame.width <= 0 || frame.height <= 0) return { x: 0, y: 0 };
  const scale = Math.max(frame.width / natural.width, frame.height / natural.height);
  return {
    x: overhang(natural.width * scale, frame.width),
    y: overhang(natural.height * scale, frame.height),
  };
}

/**
 * The focus after dragging the picture by (dx, dy) frame pixels from the
 * drag's start. Dragging the picture to the right reveals its LEFT edge,
 * so the position percentage falls; the full overhang is the full 0..100
 * range, which is exactly how far the picture can move.
 */
export function panFocus(start: ImageFocus, dx: number, dy: number, overflow: { x: number; y: number }): ImageFocus {
  return {
    x: overflow.x > 0 ? clampPct(start.x - (dx / overflow.x) * 100) : clampPct(start.x),
    y: overflow.y > 0 ? clampPct(start.y - (dy / overflow.y) * 100) : clampPct(start.y),
  };
}

/** true when a stored focus means anything other than the default centre */
export const isOffCentre = (focus?: ImageFocus | null): boolean =>
  !!focus && (clampPct(focus.x) !== CENTER_FOCUS.x || clampPct(focus.y) !== CENTER_FOCUS.y);
