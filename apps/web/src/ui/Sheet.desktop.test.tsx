// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { PRESS_FRESH_MS, Sheet, leaveGhost, openingPoint, panelAwayTransform, sheetLibAvoidsKeyboard } from './Sheet';

const stubDesktop = () => {
  const original = window.matchMedia;
  window.matchMedia = (() => ({
    matches: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
};

const dialogFor = (ui: React.ReactElement): HTMLDialogElement => {
  render(<LangProvider>{ui}</LangProvider>);
  const dialog = document.querySelector('dialog');
  expect(dialog).toBeTruthy();
  return dialog!;
};

/** the geometry (auto height, ceiling, floor) is measured in the WebKit desktop spec: happy-dom has no layout */
describe('desktop dialog', () => {
  it('#290: the dialog opts out of the app-level focus reveal', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t" size="form">
          <div />
        </Sheet>,
      );
      // AppLayout's keyboard reveal centers a focused field in the nearest scroller (a yank without an on-screen keyboard);
      // it stands down inside this class wherever SHEET_OWNS_KEYBOARD, so the dialog must wear it
      expect(dialog.className).toContain('react-modal-sheet-container');
    } finally {
      restore();
    }
  });

  it('the full size stands the dialog at its ceiling so content can fill it (user request 2026-10-01)', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t" size="full">
          <div />
        </Sheet>,
      );
      // the geometry itself is the WebKit spec's; happy-dom drops a min() value
      expect(dialog.hasAttribute('data-full')).toBe(true);
    } finally {
      restore();
    }
  });

  it('#389/#390: a pinned footer keeps the rounded bottom corners — the dialog clips what it holds', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t" size="tall" footer={<button data-testid="footer-btn">ok</button>}>
          <div />
        </Sheet>,
      );
      expect(dialog.contains(screen.getByTestId('footer-btn'))).toBe(true);
      expect(dialog.className).toContain('overflow-hidden');
      expect(dialog.className).toContain('rounded-[20px]');
    } finally {
      restore();
    }
  });

  it('the content area is the scroller, so a taller-than-ceiling body scrolls inside', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t" size="tall">
          <div data-testid="tall-content" style={{ height: 2000 }} />
        </Sheet>,
      );
      const scroller = dialog.querySelector('.overflow-y-auto');
      expect(scroller).toBeTruthy();
      expect(scroller!.contains(screen.getByTestId('tall-content'))).toBe(true);
    } finally {
      restore();
    }
  });
});

describe('#658: the desktop dialog comes out of the control that opened it and goes back into it', () => {
  const press = (x: number, y: number) => fireEvent.pointerDown(document.body, { clientX: x, clientY: y });
  const awayFrom = (x: number, y: number) => panelAwayTransform({ x, y }, { width: window.innerWidth, height: window.innerHeight });
  const panel = () => document.querySelector<HTMLElement>('[data-sheet-panel]');

  it('the very first frame stands on the press, on a sheet that never opened before', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      press(900, 60);
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t" size="form">
          <div />
        </Sheet>,
      );
      expect(panel()!.style.transform).toBe(awayFrom(900, 60));
      expect(panel()!.style.opacity).toBe('0');
      // the stack writes transform and opacity straight onto the dialog: the coming and going must not live there
      expect(dialog.style.transform).toBe('');
      expect(dialog.style.opacity).toBe('');
    } finally {
      restore();
    }
  });

  it('it grows to its place, and closing sends it back to the same point before it leaves', async () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      press(120, 640);
      const ui = (open: boolean) => (
        <LangProvider>
          <Sheet open={open} onOpenChange={() => undefined} title="t" size="form">
            <div />
          </Sheet>
        </LangProvider>
      );
      const { rerender } = render(ui(true));
      await waitFor(() => expect(panel()!.style.transform).toBe('none'));
      expect(panel()!.style.opacity).toBe('1');

      // a press somewhere else while it is open does not move where it goes back to
      press(500, 500);
      rerender(ui(false));
      await waitFor(() => expect(panel()!.style.transform).toBe(awayFrom(120, 640)));
      expect(panel()!.style.opacity).toBe('0');
      await waitFor(() => expect(document.querySelector('dialog')).toBeNull());
    } finally {
      restore();
    }
  });

  it('a dialog its screen removes while open leaves a lifeless copy that goes back in its place, then is gone', async () => {
    const layer = document.createElement('div');
    layer.innerHTML =
      '<button data-sheet-backdrop=""></button><div data-sheet-panel="" data-testid="sheet-panel"><dialog data-sheet-body="" id="d1"><input data-testid="field" /></dialog></div>';
    document.body.appendChild(layer);
    leaveGhost(layer, 'translate(10px, 20px) scale(0.1)');
    layer.remove();

    const ghost = document.querySelector<HTMLElement>('[aria-hidden="true"][inert]');
    expect(ghost).toBeTruthy();
    expect(ghost!.style.pointerEvents).toBe('none');
    // nothing in the copy answers a query meant for the real dialog
    expect(ghost!.querySelector('[data-testid], [id], [data-sheet-body]')).toBeNull();
    expect(ghost!.querySelector('[data-sheet-panel]')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('[aria-hidden="true"][inert]')).toBeNull());
  });

  it('content that would restart when copied (a streamed page) gets no copy', () => {
    const layer = document.createElement('div');
    layer.innerHTML = '<div data-sheet-panel=""><dialog><video></video></dialog></div>';
    document.body.appendChild(layer);
    leaveGhost(layer, 'none');
    expect(document.querySelector('[aria-hidden="true"][inert]')).toBeNull();
    layer.remove();
  });

  it('a press names the origin only while it is fresh; opened by the app itself, the dialog grows in place', () => {
    press(300, 200);
    expect(openingPoint()).toEqual({ x: 300, y: 200 });
    expect(openingPoint(performance.now() + PRESS_FRESH_MS + 1)).toBeNull();
    expect(panelAwayTransform(null, { width: 1200, height: 800 })).toBe('translate(0px, 0px) scale(0.1)');
    expect(panelAwayTransform({ x: 1100, y: 40 }, { width: 1200, height: 800 })).toBe('translate(500px, -360px) scale(0.1)');
  });
});

// #290: desktop Chromium exposes navigator.virtualKeyboard keyboard-less and the sheet library reads it as "keyboard open":
// avoidance must engage by pointer, not platform (fine pointer = stand down); happy-dom has no layout,
// so the test specs the exported decision the Sheet feeds the library, not the DOM
describe('#290 r2: mobile-sheet keyboard avoidance engages by pointer', () => {
  const stubPointer = (coarse: boolean) => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      // only '(pointer: coarse)' answers per stub; every other query (the lg breakpoint) stays false
      matches: coarse && query.includes('pointer: coarse'),
      addEventListener: () => {},
      removeEventListener: () => {},
    })) as unknown as typeof window.matchMedia;
    return () => {
      window.matchMedia = original;
    };
  };

  it('fine pointer (plain desktop): the library stands down — nothing scrolls a focused field', () => {
    const restore = stubPointer(false);
    try {
      expect(sheetLibAvoidsKeyboard()).toBe(false);
    } finally {
      restore();
    }
  });

  it('coarse pointer (touch tablets): the avoidance stays — the real-keyboard path is untouched', () => {
    const restore = stubPointer(true);
    try {
      expect(sheetLibAvoidsKeyboard()).toBe(true);
    } finally {
      restore();
    }
  });
});
