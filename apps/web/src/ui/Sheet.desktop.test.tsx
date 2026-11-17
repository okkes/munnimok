// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { Sheet, sheetLibAvoidsKeyboard } from './Sheet';

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
