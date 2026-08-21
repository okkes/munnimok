// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { Sheet } from './Sheet';

/** lg viewport: the Sheet renders its centered desktop dialog */
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

describe('desktop dialog sizing (#276)', () => {
  it('grows with content: auto height, a viewport ceiling and a size-derived floor', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t" size="form">
          <div data-testid="dlg-content" />
        </Sheet>,
      );
      expect(screen.getByTestId('dlg-content')).toBeTruthy();
      expect(dialog.style.height).toBe('auto');
      // form = 440px on the phone; the dialog keeps 60% as its floor
      expect(dialog.style.minHeight).toBe('264px');
      expect(dialog.style.maxHeight).toBe('min(85dvh, 900px)');
    } finally {
      restore();
    }
  });

  it('a size-less sheet stays fully content-sized (no floor)', () => {
    localStorage.setItem('munni_lang', 'en');
    const restore = stubDesktop();
    try {
      const dialog = dialogFor(
        <Sheet open onOpenChange={() => undefined} title="t">
          <div />
        </Sheet>,
      );
      expect(dialog.style.height).toBe('auto');
      expect(dialog.style.minHeight).toBe('');
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
