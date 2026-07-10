// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { initPressFeedback } from './pressFeedback';

const touchDown = (el: Element) =>
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));

describe('press feedback (touch affordance)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('marks a resting touch as pressed and clears it on cancel (scroll takeover)', () => {
    vi.useFakeTimers();
    initPressFeedback();
    const row = document.createElement('button');
    row.className = 'm-tap';
    document.body.appendChild(row);

    touchDown(row);
    expect(row.hasAttribute('data-pressed')).toBe(false); // not yet — flick grace
    vi.advanceTimersByTime(80);
    expect(row.hasAttribute('data-pressed')).toBe(true);

    document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerType: 'touch' }));
    expect(row.hasAttribute('data-pressed')).toBe(false);
  });

  it('ignores mouse pointers and non-tappable targets', () => {
    vi.useFakeTimers();
    initPressFeedback();
    const row = document.createElement('button');
    row.className = 'm-tap';
    const plain = document.createElement('div');
    document.body.append(row, plain);

    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    touchDown(plain);
    vi.advanceTimersByTime(120);
    expect(row.hasAttribute('data-pressed')).toBe(false);
    expect(plain.hasAttribute('data-pressed')).toBe(false);
  });
});
