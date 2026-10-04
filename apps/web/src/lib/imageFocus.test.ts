import { describe, expect, it } from 'vitest';
import { CENTER_FOCUS, coverOverflow, focusPosition, isOffCentre, panFocus } from './imageFocus';

describe('image focus math (#446)', () => {
  it('a missing focus is the centre; a stored one renders as object-position percentages', () => {
    expect(focusPosition()).toBe('50% 50%');
    expect(focusPosition(null)).toBe('50% 50%');
    expect(focusPosition({ x: 12, y: 80 })).toBe('12% 80%');
    // out-of-range and fractional values are tidied, never passed to CSS raw
    expect(focusPosition({ x: -5, y: 130.6 })).toBe('0% 100%');
  });

  it('cover overflow is the overhang on the axis the frame crops, zero on the one that fits', () => {
    // a wide picture in a wider-still frame: scaled to the frame's width, overhangs below
    expect(coverOverflow({ width: 1200, height: 800 }, { width: 300, height: 100 })).toEqual({ x: 0, y: 100 });
    // a wide picture in a squarer frame: scaled to the frame's height, overhangs sideways
    expect(coverOverflow({ width: 1200, height: 400 }, { width: 300, height: 112 })).toEqual({ x: 36, y: 0 });
    // the same aspect: nothing to pan
    expect(coverOverflow({ width: 600, height: 200 }, { width: 300, height: 100 })).toEqual({ x: 0, y: 0 });
    // unknown sizes: nothing to pan either
    expect(coverOverflow({ width: 0, height: 0 }, { width: 300, height: 100 })).toEqual({ x: 0, y: 0 });
    expect(coverOverflow({ width: 1200, height: 800 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });

  it('dragging the picture right reveals its left edge (the position falls), clamped to the edges', () => {
    const overflow = { x: 200, y: 0 };
    expect(panFocus(CENTER_FOCUS, 50, 0, overflow)).toEqual({ x: 25, y: 50 });
    expect(panFocus(CENTER_FOCUS, -50, 0, overflow)).toEqual({ x: 75, y: 50 });
    expect(panFocus(CENTER_FOCUS, 400, 0, overflow)).toEqual({ x: 0, y: 50 });
    expect(panFocus(CENTER_FOCUS, -400, 0, overflow)).toEqual({ x: 100, y: 50 });
    // the axis with nothing to pan ignores the drag along it
    expect(panFocus(CENTER_FOCUS, 0, 80, overflow)).toEqual({ x: 50, y: 50 });
    expect(panFocus({ x: 50, y: 50 }, 0, -30, { x: 0, y: 60 })).toEqual({ x: 50, y: 100 });
  });

  it('a stored focus is off-centre only when it says something other than 50/50', () => {
    expect(isOffCentre(undefined)).toBe(false);
    expect(isOffCentre({ x: 50, y: 50 })).toBe(false);
    expect(isOffCentre({ x: 50.2, y: 49.8 })).toBe(false);
    expect(isOffCentre({ x: 0, y: 50 })).toBe(true);
  });
});
