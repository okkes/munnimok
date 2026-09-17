// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isClippedFromView, nearestScrollport, padScrollportForKeyboard, restoreScrollportPad, revealInScroller } from './viewport';

const build = () => {
  document.body.innerHTML = '';
  const scroller = document.createElement('div');
  scroller.style.overflowY = 'auto';
  const wrapper = document.createElement('div'); // plain, not a scroller
  const field = document.createElement('textarea');
  wrapper.appendChild(field);
  scroller.appendChild(wrapper);
  document.body.appendChild(scroller);
  return { scroller, field };
};

const setViewport = (innerHeight: number, visualHeight: number) => {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: innerHeight });
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { height: visualHeight, offsetTop: 0 },
  });
};

describe('keyboard scrollport padding (iOS layout viewport never shrinks)', () => {
  afterEach(() => {
    restoreScrollportPad();
    setViewport(800, 800);
  });

  it('nearestScrollport walks past non-scrolling wrappers and stops at body', () => {
    const { scroller, field } = build();
    expect(nearestScrollport(field)).toBe(scroller);
    const loose = document.createElement('input');
    document.body.appendChild(loose);
    expect(nearestScrollport(loose)).toBeNull();
  });

  it('pads by at least the keyboard inset and restores the previous padding on close', () => {
    const { scroller, field } = build();
    scroller.style.paddingBottom = '24px';
    setViewport(800, 500); // keyboard took 300px, layout stayed 800
    padScrollportForKeyboard(field);
    // the field can scroll clear of the keyboard: the inset plus breathing room
    expect(Number.parseFloat(scroller.style.paddingBottom)).toBeGreaterThanOrEqual(300);
    restoreScrollportPad();
    expect(scroller.style.paddingBottom).toBe('24px');
  });

  it('is a no-op when the layout viewport resized with the keyboard (Android/native)', () => {
    const { scroller, field } = build();
    setViewport(500, 500); // resized together — inset 0
    padScrollportForKeyboard(field);
    expect(scroller.style.paddingBottom).toBe('');
  });
});

/** happy-dom lays nothing out — the boxes are scripted per element */
const box = (el: HTMLElement, top: number, bottom: number, width = 100) => {
  el.getBoundingClientRect = () =>
    ({ top, bottom, height: bottom - top, width, left: 0, right: width, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
};

/** an inner list showing 100–500 on screen with plenty to scroll */
const scrollingList = () => {
  const { scroller, field } = build();
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
  box(scroller, 100, 500);
  return { scroller, field };
};

describe('visible-band checks (tutorial glow, focus reveal)', () => {
  afterEach(() => setViewport(800, 800));

  it('isClippedFromView: under the chrome or scrolled out of an inner list counts as clipped; display:none never does', () => {
    setViewport(800, 800);
    const { field } = scrollingList();
    box(field, 200, 240);
    expect(isClippedFromView(field)).toBe(false); // inside the window band AND the list's box
    box(field, 20, 60);
    expect(isClippedFromView(field)).toBe(true); // under the top chrome
    box(field, 600, 640);
    expect(isClippedFromView(field)).toBe(true); // window-plausible, but below the list's visible box
    box(field, 200, 240, 0);
    expect(isClippedFromView(field)).toBe(false); // display:none — nothing to reveal
  });

  it('revealInScroller centers the element in its nearest scroller only, and stays put when already centered', () => {
    setViewport(800, 800);
    const { scroller, field } = scrollingList();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    Object.defineProperty(scroller, 'scrollTop', { value: 50, configurable: true, writable: true });
    box(field, 400, 440); // its middle sits 120px below the band's middle
    revealInScroller(field);
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 170 }));

    scrollTo.mockClear();
    box(field, 280, 320); // already centered — no nudging
    revealInScroller(field);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
