// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { Sheet, sheetBodyHeightStyle, sheetExpandedCap, sheetPartialPx } from './Sheet';

const body = () => document.querySelector('[data-sheet-body]') as HTMLElement;

const mount = (ui: React.ReactElement) => render(<LangProvider>{ui}</LangProvider>);

describe('#312 r2: partial open + intent-driven expansion', () => {
  it('height math: half-screen partial, the 92% expanded fraction, depth steps', () => {
    expect(sheetPartialPx(800, 0)).toBe(400);
    expect(sheetPartialPx(800, 1)).toBe(372); // stacked sheets step down
    expect(sheetPartialPx(300, 0)).toBe(240); // floor
    expect(sheetExpandedCap(800, 0)).toBe(736);
    // partial caps a sized sheet at half; a shorter size keeps its own
    // height; a content sheet stays content-sized under the same cap
    expect(sheetBodyHeightStyle(false, 800, 0, 600)).toEqual({ height: 400 });
    expect(sheetBodyHeightStyle(false, 800, 0, 320)).toEqual({ height: 320 });
    expect(sheetBodyHeightStyle(false, 800, 0, undefined)).toEqual({ maxHeight: 400 });
    // #312 r3 (user): expanded IS the fraction of the live viewport —
    // the top edge stays put through keyboard open (small vh) and close
    // (full vh); content never caps it
    expect(sheetBodyHeightStyle(true, 800, 0, 600)).toEqual({ height: 736 });
    expect(sheetBodyHeightStyle(true, 500, 0, 600)).toEqual({ height: 460 });
    expect(sheetBodyHeightStyle(true, 800, 1, undefined)).toEqual({ height: 708 });
  });

  it('opens PARTIAL and expands when a field inside gains focus', async () => {
    localStorage.setItem('munni_lang', 'en');
    mount(
      <Sheet open onOpenChange={() => undefined} title="t" size="tall">
        <input data-testid="sheet-field" />
      </Sheet>,
    );
    await screen.findByTestId('sheet-field');
    const el = body();
    expect(el.dataset.expanded).toBe('0');
    // tall = 600px, but the partial open caps at half the viewport
    expect(el.style.height).toBe(`${sheetPartialPx(window.innerHeight, 0)}px`);
    fireEvent.focusIn(screen.getByTestId('sheet-field'));
    expect(el.dataset.expanded).toBe('1');
    // layoutless environment: natural height unmeasurable → the ceiling
    expect(el.style.height).toBe(`${sheetExpandedCap(window.innerHeight, 0)}px`);
  });

  it('scrolling the partial sheet content expands it; a content sheet starts under a maxHeight cap', async () => {
    localStorage.setItem('munni_lang', 'en');
    mount(
      <Sheet open onOpenChange={() => undefined} title="t">
        <div data-testid="sheet-content">rows</div>
      </Sheet>,
    );
    await screen.findByTestId('sheet-content');
    const el = body();
    expect(el.dataset.expanded).toBe('0');
    expect(el.style.maxHeight).toBe(`${sheetPartialPx(window.innerHeight, 0)}px`);
    const scroller = el.querySelector('.react-modal-sheet-content-scroller') as HTMLElement;
    expect(scroller).toBeTruthy();
    scroller.scrollTop = 8;
    fireEvent.scroll(scroller);
    expect(el.dataset.expanded).toBe('1');
    expect(el.style.height).toBe(`${sheetExpandedCap(window.innerHeight, 0)}px`);
  });
});
