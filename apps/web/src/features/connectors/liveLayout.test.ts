// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import { fitFrame, isTap, keyboardInset, nearestScroller } from './liveLayout';

describe('the streamed login’s geometry (user request 2026-10-01)', () => {
  it('fits the largest box with the page’s aspect into the room, and says so when there is no room to measure', () => {
    // a phone page (390×844) in a 350-wide, 700-tall room: the height binds
    expect(fitFrame({ availW: 350, availH: 700, frameW: 390, frameH: 844 })).toEqual({ width: 323, height: 700 });
    // a desktop dialog: plenty of height, the width binds
    expect(fitFrame({ availW: 300, availH: 2000, frameW: 390, frameH: 844 })).toEqual({ width: 300, height: 649 });
    expect(fitFrame({ availW: 0, availH: 700, frameW: 390, frameH: 844 })).toBeNull();
    expect(fitFrame({ availW: 350, availH: -20, frameW: 390, frameH: 844 })).toBeNull();
    expect(fitFrame({ availW: 350, availH: 700, frameW: 0, frameH: 844 })).toBeNull();
  });

  it('the keyboard inset is what the visual viewport lost — nought where the layout itself shrank or there is no keyboard', () => {
    expect(keyboardInset({ innerHeight: 844, visualViewport: null })).toBe(0);
    // iOS Safari / PWA: the layout stays, the visual viewport shrinks by the keyboard
    expect(keyboardInset({ innerHeight: 844, visualViewport: { height: 500, offsetTop: 0 } as VisualViewport })).toBe(344);
    // Android / the native shells: the layout shrank with it
    expect(keyboardInset({ innerHeight: 500, visualViewport: { height: 500, offsetTop: 0 } as VisualViewport })).toBe(0);
    // a scrolled visual viewport counts its offset
    expect(keyboardInset({ innerHeight: 844, visualViewport: { height: 500, offsetTop: 100 } as VisualViewport })).toBe(244);
  });

  it('a down and an up within three percent of the frame are one tap; further apart they are a drag', () => {
    expect(isTap({ x: 0.5, y: 0.5 }, { x: 0.51, y: 0.49 })).toBe(true);
    expect(isTap({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.6 })).toBe(false);
  });

  it('finds the sheet’s scroller above the view, and nothing outside one', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const inner = document.createElement('div');
    const view = document.createElement('div');
    inner.appendChild(view);
    scroller.appendChild(inner);
    document.body.appendChild(scroller);
    expect(nearestScroller(view)).toBe(scroller);
    const loose = document.createElement('div');
    document.body.appendChild(loose);
    expect(nearestScroller(loose)).toBeNull();
  });
});
