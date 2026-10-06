/**
 * The visible part of a picture that is shown "cover"-fitted (#446, user):
 * a frame narrower than the picture crops it, and where it crops is the
 * focus — CSS `object-position`, kept as two percentages. 50/50 is the
 * browser's own default, the centre; 0 is the left/top edge, 100 the
 * right/bottom one. Pure math, so the drag component and the renderers
 * agree by construction.
 *
 * 2026-10-06 (user): a zoom on top — `scale` enlarges the picture around
 * that very focus point, so what was chosen stays where it was and more of
 * the picture's middle fills the frame (the space's round picture needed
 * it most). 1 is the plain cover fit; absent means 1.
 */
export interface ImageFocus {
  /** 0..100, the horizontal object-position */
  x: number;
  /** 0..100, the vertical object-position */
  y: number;
  /** 1 = cover-fitted, up to SCALE_MAX: the picture enlarged around the focus */
  scale?: number;
}

export interface Size {
  width: number;
  height: number;
}

export const CENTER_FOCUS: ImageFocus = { x: 50, y: 50 };

export const SCALE_MIN = 1;
export const SCALE_MAX = 3;

const clampPct = (value: number): number => Math.min(100, Math.max(0, Math.round(value)));

/** the zoom tidied: within 1..SCALE_MAX, two decimals, 1 when absent */
export const clampScale = (scale: number | undefined): number =>
  Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round((scale ?? SCALE_MIN) * 100) / 100));

/** the CSS `object-position` value for a focus (the centre when none is stored) */
export const focusPosition = (focus?: ImageFocus | null): string => {
  const f = focus ?? CENTER_FOCUS;
  return `${clampPct(f.x)}% ${clampPct(f.y)}%`;
};

/**
 * The inline style for a cover-fitted picture at a focus: the position, and
 * past 1× a scale around that same point. object-position puts the picture's
 * focus point at the frame's focus point, and scaling the element around that
 * frame point keeps it there — so the two percentages serve both at once.
 */
export function focusStyle(focus?: ImageFocus | null): { objectPosition: string; transform?: string; transformOrigin?: string } {
  const objectPosition = focusPosition(focus);
  const scale = clampScale(focus?.scale);
  return scale > 1 ? { objectPosition, transform: `scale(${scale})`, transformOrigin: objectPosition } : { objectPosition };
}

/** rounded to a thousandth of a pixel — the axis that fits comes out as
 *  112.00000000000001 minus 112 in floating point, and that is no overhang;
 *  nor is anything under half a pixel, which no drag could pan */
const overhang = (rendered: number, size: number): number => {
  const over = Math.round((rendered - size) * 1000) / 1000;
  return over > 0.5 ? over : 0;
};

/**
 * How far a cover-fitted picture overhangs its frame, per axis, in frame
 * pixels — at the given zoom, which multiplies the rendered size. Zero on
 * the axis that fits exactly — there is nothing to pan there — and zero
 * everywhere while either size is unknown.
 */
export function coverOverflow(natural: Size, frame: Size, scale = 1): { x: number; y: number } {
  if (natural.width <= 0 || natural.height <= 0 || frame.width <= 0 || frame.height <= 0) return { x: 0, y: 0 };
  const fit = Math.max(frame.width / natural.width, frame.height / natural.height) * clampScale(scale);
  return {
    x: overhang(natural.width * fit, frame.width),
    y: overhang(natural.height * fit, frame.height),
  };
}

/**
 * The focus after dragging the picture by (dx, dy) frame pixels from the
 * drag's start. Dragging the picture to the right reveals its LEFT edge,
 * so the position percentage falls; the full overhang is the full 0..100
 * range, which is exactly how far the picture can move. The zoom rides
 * along untouched.
 */
export function panFocus(start: ImageFocus, dx: number, dy: number, overflow: { x: number; y: number }): ImageFocus {
  return {
    ...start,
    x: overflow.x > 0 ? clampPct(start.x - (dx / overflow.x) * 100) : clampPct(start.x),
    y: overflow.y > 0 ? clampPct(start.y - (dy / overflow.y) * 100) : clampPct(start.y),
  };
}

/** true when a stored focus means anything other than the default centre at 1× */
export const isOffCentre = (focus?: ImageFocus | null): boolean =>
  !!focus && (clampPct(focus.x) !== CENTER_FOCUS.x || clampPct(focus.y) !== CENTER_FOCUS.y || clampScale(focus.scale) > 1);
