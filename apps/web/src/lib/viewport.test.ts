// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { nearestScrollport, padScrollportForKeyboard, releaseScrollportPad, restoreScrollportPad } from './viewport';

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

  it('pads by the keyboard inset and restores the previous padding on close', () => {
    const { scroller, field } = build();
    scroller.style.paddingBottom = '24px';
    setViewport(800, 500); // keyboard took 300px, layout stayed 800
    padScrollportForKeyboard(field);
    expect(scroller.style.paddingBottom).toBe('316px'); // 300 inset + 16 breathing room
    restoreScrollportPad();
    expect(scroller.style.paddingBottom).toBe('24px');
  });

  it('is a no-op when the layout viewport resized with the keyboard (Android/native)', () => {
    const { scroller, field } = build();
    setViewport(500, 500); // resized together — inset 0
    padScrollportForKeyboard(field);
    expect(scroller.style.paddingBottom).toBe('');
  });

  // #312 r2 (user, the Mario rule): the pad is not yanked while the
  // user is LOOKING at it — release waits until it scrolls out of view
  it('release keeps a visible pad standing and removes it once scrolled out of sight', () => {
    const { scroller, field } = build();
    setViewport(800, 500);
    padScrollportForKeyboard(field);
    expect(scroller.style.paddingBottom).toBe('316px');
    // deep in the list: the padded zone is on screen (happy-dom metrics
    // are all 0, so scrollTop+clientHeight > scrollHeight-pad holds)
    releaseScrollportPad();
    expect(scroller.style.paddingBottom).toBe('316px'); // still standing
    // the user scrolls; once the pad is below the fold it comes off —
    // simulate the out-of-view geometry, then fire the scroll
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 0; // 0 + 400 <= 1000 - 316 → invisible
    scroller.dispatchEvent(new Event('scroll'));
    expect(scroller.style.paddingBottom).toBe('');
  });

  it('release removes an already-invisible pad immediately', () => {
    const { scroller, field } = build();
    setViewport(800, 500);
    padScrollportForKeyboard(field);
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 0;
    releaseScrollportPad();
    expect(scroller.style.paddingBottom).toBe('');
  });

  it('a re-focus while a release is armed keeps the pad and disarms the watcher', () => {
    const { scroller, field } = build();
    setViewport(800, 500);
    padScrollportForKeyboard(field);
    releaseScrollportPad(); // visible → armed
    padScrollportForKeyboard(field); // typing again
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    scroller.scrollTop = 0;
    scroller.dispatchEvent(new Event('scroll')); // the OLD watcher must be gone
    expect(scroller.style.paddingBottom).toBe('316px');
  });
});
