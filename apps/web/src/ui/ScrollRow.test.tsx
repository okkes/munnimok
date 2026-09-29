// @vitest-environment happy-dom
import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScrollRow } from './ScrollRow';

/** happy-dom lays nothing out — the strip's geometry is declared */
function geometry(el: HTMLElement, scrollWidth: number, clientWidth: number, scrollLeft = 0) {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  Object.defineProperty(el, 'scrollLeft', { value: scrollLeft, configurable: true, writable: true });
}

describe('#376: the horizontal strip says when more sits beyond its edge', () => {
  it('fades the right edge while content overflows, the left edge once scrolled, neither at a fit', () => {
    const { container, getByTestId } = render(
      <ScrollRow testId="strip">
        <span>a</span>
        <span>b</span>
      </ScrollRow>,
    );
    const wrapper = container.querySelector('[data-scroll-row]') as HTMLElement;
    const strip = getByTestId('strip');

    geometry(strip, 600, 300);
    fireEvent.scroll(strip);
    expect(wrapper.dataset.moreRight).toBe('1');
    expect(wrapper.dataset.moreLeft).toBeUndefined();

    geometry(strip, 600, 300, 300);
    fireEvent.scroll(strip);
    expect(wrapper.dataset.moreRight).toBeUndefined();
    expect(wrapper.dataset.moreLeft).toBe('1');

    geometry(strip, 300, 300);
    fireEvent.scroll(strip);
    expect(wrapper.dataset.moreRight).toBeUndefined();
    expect(wrapper.dataset.moreLeft).toBeUndefined();
  });
});
