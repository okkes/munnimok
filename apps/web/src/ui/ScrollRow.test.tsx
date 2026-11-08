// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LangProvider } from '@/i18n';
// harness registers RTL cleanup between tests
import '@/test/harness';
import { ScrollRow, edgeMask } from './ScrollRow';

/** happy-dom lays nothing out — the strip's geometry is declared */
function geometry(el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft, configurable: true, writable: true });
}

const renderStrip = () => {
  localStorage.setItem('munni_lang', 'en');
  return render(
    <LangProvider>
      <ScrollRow testId="strip">
        <span>a</span>
        <span>b</span>
      </ScrollRow>
    </LangProvider>,
  );
};

describe('#376: the horizontal strip says when more sits beyond its edge', () => {
  it('fades and arrows the right edge while content overflows, the left edge once scrolled, neither at a fit', () => {
    const { container, getByTestId } = renderStrip();
    const wrapper = container.querySelector('[data-scroll-row]') as HTMLElement;
    const strip = getByTestId('strip');
    const left = getByTestId('strip-left');
    const right = getByTestId('strip-right');

    geometry(strip, 600, 300);
    fireEvent.scroll(strip);
    expect(wrapper.dataset.moreRight).toBe('1');
    expect(wrapper.dataset.moreLeft).toBeUndefined();
    expect(right.getAttribute('aria-hidden')).toBe('false');
    expect(left.getAttribute('aria-hidden')).toBe('true');
    expect(strip.style.maskImage).toContain('transparent');

    geometry(strip, 600, 300, 300);
    fireEvent.scroll(strip);
    expect(wrapper.dataset.moreRight).toBeUndefined();
    expect(wrapper.dataset.moreLeft).toBe('1');
    expect(left.getAttribute('aria-hidden')).toBe('false');
    expect(right.getAttribute('aria-hidden')).toBe('true');

    geometry(strip, 300, 300);
    fireEvent.scroll(strip);
    expect(wrapper.dataset.moreRight).toBeUndefined();
    expect(wrapper.dataset.moreLeft).toBeUndefined();
    expect(strip.style.maskImage).toBe('');
  });

  it('r2: the arrows are buttons — a tap pages the strip by most of its width, each way', () => {
    const { getByTestId } = renderStrip();
    const strip = getByTestId('strip');
    geometry(strip, 900, 400, 200);
    fireEvent.scroll(strip);
    const scrollBy = vi.fn();
    strip.scrollBy = scrollBy as never;
    fireEvent.click(getByTestId('strip-right'));
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: 300 }));
    fireEvent.click(getByTestId('strip-left'));
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: -300 }));
    expect(getByTestId('strip-right').getAttribute('aria-label')).toBe('Scroll right');
  });

  it('the fade masks only the edges that hide more', () => {
    expect(edgeMask(false, false)).toBeUndefined();
    expect(edgeMask(false, true)?.maskImage).toMatch(/^linear-gradient\(to right, #000,.*transparent\)$/);
    expect(edgeMask(true, false)?.maskImage).toMatch(/^linear-gradient\(to right, transparent,.*#000\)$/);
    expect(edgeMask(true, true)?.WebkitMaskImage).toBe(edgeMask(true, true)?.maskImage);
  });
});
