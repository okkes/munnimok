// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flashJumpTo } from './flashJump';

const target = () => {
  const el = document.createElement('div');
  el.scrollIntoView = vi.fn();
  document.body.appendChild(el);
  return el;
};

describe('flashJumpTo (jump to a row and pulse it)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });
  afterEach(() => vi.useRealTimers());

  it('scrolls the target into view, pulses once the scroll has settled, and the pulse fades by itself', () => {
    const el = target();
    flashJumpTo(el);
    expect(el.scrollIntoView).toHaveBeenCalledWith(expect.objectContaining({ block: 'center' }));
    // nothing pulses while the page may still be moving
    expect(el.dataset.flash).toBeUndefined();
    // two quiet position polls in a row = the scroll settled
    vi.advanceTimersByTime(200);
    expect(el.dataset.flash).toBe('1');
    vi.advanceTimersByTime(1600);
    expect(el.dataset.flash).toBeUndefined();
  });

  it('a scrollend event settles the jump at once; a second jump restarts the pulse instead of stacking fades', () => {
    const el = target();
    flashJumpTo(el);
    window.dispatchEvent(new Event('scrollend'));
    expect(el.dataset.flash).toBe('1');

    // jump again mid-pulse: the first fade is cancelled, the new pulse runs whole
    vi.advanceTimersByTime(1000);
    flashJumpTo(el);
    window.dispatchEvent(new Event('scrollend'));
    vi.advanceTimersByTime(1000); // the FIRST fade would have fired by now
    expect(el.dataset.flash).toBe('1');
    vi.advanceTimersByTime(700);
    expect(el.dataset.flash).toBeUndefined();
  });
});
