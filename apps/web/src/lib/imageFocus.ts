// focus = CSS object-position as two percentages (50/50 centre, 0 left/top, 100 right/bottom) of a cover-fitted picture
// scale enlarges the picture around that same focus point; 1 = plain cover fit, absent = 1
export interface ImageFocus {
  x: number;
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

export const clampScale = (scale: number | undefined): number =>
  Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round((scale ?? SCALE_MIN) * 100) / 100));

export const focusPosition = (focus?: ImageFocus | null): string => {
  const f = focus ?? CENTER_FOCUS;
  return `${clampPct(f.x)}% ${clampPct(f.y)}%`;
};

/** object-position puts the picture's focus at the frame's focus; scaling around that frame point keeps it there */
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

export function coverOverflow(natural: Size, frame: Size, scale = 1): { x: number; y: number } {
  if (natural.width <= 0 || natural.height <= 0 || frame.width <= 0 || frame.height <= 0) return { x: 0, y: 0 };
  const fit = Math.max(frame.width / natural.width, frame.height / natural.height) * clampScale(scale);
  return {
    x: overhang(natural.width * fit, frame.width),
    y: overhang(natural.height * fit, frame.height),
  };
}

/** dragging the picture right reveals its LEFT edge, so the percentage falls; the zoom rides along */
export function panFocus(start: ImageFocus, dx: number, dy: number, overflow: { x: number; y: number }): ImageFocus {
  return {
    ...start,
    x: overflow.x > 0 ? clampPct(start.x - (dx / overflow.x) * 100) : clampPct(start.x),
    y: overflow.y > 0 ? clampPct(start.y - (dy / overflow.y) * 100) : clampPct(start.y),
  };
}

export const isOffCentre = (focus?: ImageFocus | null): boolean =>
  !!focus && (clampPct(focus.x) !== CENTER_FOCUS.x || clampPct(focus.y) !== CENTER_FOCUS.y || clampScale(focus.scale) > 1);
