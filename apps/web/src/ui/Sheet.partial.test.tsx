// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { Sheet, sheetBodyHeightStyle, sheetExpandedCap, sheetGrowTarget, sheetPartialPx } from './Sheet';

const body = () => document.querySelector('[data-sheet-body]') as HTMLElement;

const mount = (ui: React.ReactElement) => render(<LangProvider>{ui}</LangProvider>);

describe('#312 r4: content-wrapped partial + gesture-paced growth', () => {
  it('height math: the half cap, the growth target, the eat clamp', () => {
    expect(sheetPartialPx(800, 0)).toBe(400);
    expect(sheetPartialPx(800, 1)).toBe(372); // stacked sheets step down
    expect(sheetExpandedCap(800, 0)).toBe(736);
    // ungrown = content-wrapped under the cap (r4: sized sheets too)
    expect(sheetBodyHeightStyle(800, 0, 0, 0, 0)).toEqual({ maxHeight: 400 });
    expect(sheetBodyHeightStyle(800, 0, 320, 0, 736)).toEqual({ maxHeight: 400 });
    // grown = explicit base+grown, never past the target
    expect(sheetBodyHeightStyle(800, 0, 320, 100, 736)).toEqual({ height: 420 });
    expect(sheetBodyHeightStyle(800, 0, 320, 9999, 736)).toEqual({ height: 736 });
    // the target: content-clamped (a fitting sheet has no room)…
    expect(sheetGrowTarget(800, 0, 300, Number.POSITIVE_INFINITY)).toBe(300);
    expect(sheetGrowTarget(800, 0, 2000, Number.POSITIVE_INFINITY)).toBe(736);
    // …and the keyboard ratchet raises it: a top edge held at 44px keeps
    // the sheet 756-wanted (capped) after the viewport grows back
    expect(sheetGrowTarget(800, 0, 300, 44)).toBe(736);
  });

  it('focusing a field takes the full target smoothly (layoutless: the ceiling)', async () => {
    localStorage.setItem('munni_lang', 'en');
    mount(
      <Sheet open onOpenChange={() => undefined} title="t" size="tall">
        <input data-testid="sheet-field" />
      </Sheet>,
    );
    await screen.findByTestId('sheet-field');
    const el = body();
    expect(el.dataset.expanded).toBe('0');
    // r4: even a SIZED sheet wraps content at partial — a maxHeight cap
    expect(el.style.maxHeight).toBe(`${sheetPartialPx(window.innerHeight, 0)}px`);
    expect(el.style.height).toBe('');
    fireEvent.focusIn(screen.getByTestId('sheet-field'));
    expect(el.dataset.expanded).toBe('1');
    // layoutless: natural is unmeasurable → the ceiling
    expect(el.style.height).toBe(`${sheetExpandedCap(window.innerHeight, 0)}px`);
  });

  it('a scroll grows the sheet 1:1 — the gesture is eaten before the content moves', async () => {
    localStorage.setItem('munni_lang', 'en');
    mount(
      <Sheet open onOpenChange={() => undefined} title="t">
        <div data-testid="sheet-content">rows</div>
      </Sheet>,
    );
    await screen.findByTestId('sheet-content');
    const el = body();
    const scroller = el.querySelector('.react-modal-sheet-content-scroller') as HTMLElement;
    scroller.scrollTop = 8;
    fireEvent.scroll(scroller);
    // layoutless base is 0 — the eaten 8px IS the height, and the
    // scroller's position was consumed back to zero
    expect(el.dataset.expanded).toBe('1');
    expect(el.style.height).toBe('8px');
    expect(scroller.scrollTop).toBe(0);
    // the next 12px of scroll keep growing it — paced, not a jump
    scroller.scrollTop = 12;
    fireEvent.scroll(scroller);
    expect(el.style.height).toBe('20px');
  });
});
