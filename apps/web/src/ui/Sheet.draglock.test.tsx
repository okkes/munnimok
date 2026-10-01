// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { Sheet } from './Sheet';

/** a scroller that is scrolled away from its top, as the keyboard reveal leaves the sheet's own */
function scrolledAway(el: HTMLElement) {
  Object.defineProperty(el, 'scrollHeight', { value: 400, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: 100, configurable: true });
  Object.defineProperty(el, 'scrollTop', { value: 40, configurable: true });
}

describe('dragLock + the full height (user request 2026-10-01: taps on the streamed page died once the sheet had scrolled)', () => {
  it('without the lock a pointer landing in a scrolled scroller is the sheet’s; with it the content gets every pointer, and the sheet stands at the full height', () => {
    const seen = vi.fn();
    const ui = (dragLock: boolean) => (
      <LangProvider>
        <Sheet open onOpenChange={() => undefined} title="t" size="full" dragLock={dragLock}>
          <div data-testid="scroller" style={{ overflowY: 'auto' }}>
            <button data-testid="probe" onPointerDown={seen}>
              page
            </button>
          </div>
        </Sheet>
      </LangProvider>
    );

    const first = render(ui(false));
    scrolledAway(screen.getByTestId('scroller'));
    fireEvent.pointerDown(screen.getByTestId('probe'));
    expect(seen).not.toHaveBeenCalled();
    first.unmount();

    render(ui(true));
    scrolledAway(screen.getByTestId('scroller'));
    fireEvent.pointerDown(screen.getByTestId('probe'));
    expect(seen).toHaveBeenCalledTimes(1);
    const body = document.querySelector('[data-sheet-body]') as HTMLElement;
    expect(body.hasAttribute('data-full')).toBe(true);
    expect(body.style.height).toContain('100dvh');
  });
});
