// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installKeyboardDismiss } from './keyboardDismiss';

let uninstall: (() => void) | null = null;
let restoreMatchMedia: (() => void) | null = null;

const setPointer = (coarse: boolean) => {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: coarse)' ? coarse : false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
  restoreMatchMedia = () => {
    window.matchMedia = original;
  };
};

// happy-dom has no TouchEvent constructor — a plain event with a touches
// list is exactly what the handler reads
const touch = (type: 'touchstart' | 'touchmove', target: EventTarget, x: number, y: number) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] });
  target.dispatchEvent(e);
};

const pressEnter = (target: EventTarget, init: KeyboardEventInit = {}, composing = false) => {
  const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init });
  if (composing) Object.defineProperty(e, 'isComposing', { value: true });
  target.dispatchEvent(e);
};

const mountInput = (tag: 'input' | 'textarea') => {
  const el = document.createElement(tag);
  document.body.appendChild(el);
  el.focus();
  expect(document.activeElement).toBe(el);
  return el;
};

describe('installKeyboardDismiss', () => {
  beforeEach(() => {
    setPointer(true);
    uninstall = installKeyboardDismiss();
  });
  afterEach(() => {
    uninstall?.();
    uninstall = null;
    restoreMatchMedia?.();
    restoreMatchMedia = null;
    document.body.innerHTML = '';
  });

  it('Enter blurs a focused input on touch devices', () => {
    const el = mountInput('input');
    pressEnter(el);
    expect(document.activeElement).not.toBe(el);
  });

  it('Enter blurs a notes textarea too (user rule: no multiline expected)', () => {
    const el = mountInput('textarea');
    pressEnter(el);
    expect(document.activeElement).not.toBe(el);
  });

  it('Shift+Enter keeps the field focused (hardware-keyboard newline)', () => {
    const el = mountInput('textarea');
    pressEnter(el, { shiftKey: true });
    expect(document.activeElement).toBe(el);
  });

  it('IME confirmation Enter never blurs', () => {
    const el = mountInput('input');
    pressEnter(el, {}, true);
    expect(document.activeElement).toBe(el);
  });

  it('fine pointers (desktop) keep Enter untouched', () => {
    restoreMatchMedia?.();
    setPointer(false);
    const el = mountInput('input');
    pressEnter(el);
    expect(document.activeElement).toBe(el);
  });

  it('a touch-drag outside the field hides the keyboard', () => {
    const el = mountInput('input');
    touch('touchstart', document.body, 100, 300);
    touch('touchmove', document.body, 100, 280);
    expect(document.activeElement).not.toBe(el);
  });

  it('a drag inside the focused field is selection work, not a scroll', () => {
    const el = mountInput('textarea');
    touch('touchstart', el, 100, 300);
    touch('touchmove', el, 100, 240);
    expect(document.activeElement).toBe(el);
  });

  it('a sub-threshold wobble is a tap, not a scroll', () => {
    const el = mountInput('input');
    touch('touchstart', document.body, 100, 300);
    touch('touchmove', document.body, 104, 296);
    expect(document.activeElement).toBe(el);
  });

  it('a drag on a fine-pointer device never blurs', () => {
    restoreMatchMedia?.();
    setPointer(false);
    const el = mountInput('input');
    touch('touchstart', document.body, 100, 300);
    touch('touchmove', document.body, 100, 200);
    expect(document.activeElement).toBe(el);
  });
});
