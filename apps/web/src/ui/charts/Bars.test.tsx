// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Bars } from './Bars';
// harness registers RTL cleanup between tests
import '@/test/harness';

describe('Bars (user 2026-10-08: numbers on top, a pick with a ring)', () => {
  it('writes every value label above its bar and rings the selected one', () => {
    const onSelect = vi.fn();
    render(
      <Bars
        testId="b"
        values={[1000, 0, 2500]}
        valueLabels={['€10', '€0', '€25']}
        labels={['Jan', '', 'Mar']}
        hollowLast
        selectedIndex={2}
        onSelect={onSelect}
      />,
    );
    const texts = [...screen.getByTestId('b').querySelectorAll('text')].map((node) => node.textContent);
    expect(texts).toEqual(['€10', 'Jan', '€0', '€25', 'Mar']);
    const bar = screen.getByTestId('b-bar-2');
    const rect = bar.querySelectorAll('rect');
    const label = bar.querySelector('text')!;
    expect(Number(label.getAttribute('y'))).toBeLessThan(Number(rect[1].getAttribute('y')));
    expect(screen.getByTestId('b-selected')).toBeTruthy();
    expect(screen.getByTestId('b-bar-0').querySelectorAll('rect')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('b-bar-0'));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('#375: the dashed reference line names itself at its right end — above it, or under it when it runs along the top', () => {
    render(<Bars testId="lim" values={[500, 1500]} average={1000} averageLabel="Budget €10.00" />);
    const line = screen.getByTestId('lim-average');
    const label = screen.getByTestId('lim-average-label');
    expect(label.textContent).toBe('Budget €10.00');
    expect(label.getAttribute('text-anchor')).toBe('end');
    expect(Number(label.getAttribute('y'))).toBeLessThan(Number(line.getAttribute('y1')));
    render(<Bars testId="top" values={[100, 200]} average={1000} averageLabel="Budget €10.00" />);
    expect(Number(screen.getByTestId('top-average-label').getAttribute('y'))).toBeGreaterThan(Number(screen.getByTestId('top-average').getAttribute('y1')));
  });

  it('#375 r3: the words of the line label carry no outline of their own — the halo is a copy drawn under them', () => {
    render(<Bars testId="halo" values={[500, 1500]} average={1000} averageLabel="Budget €10.00" />);
    const label = screen.getByTestId('halo-average-label');
    expect(label.getAttribute('stroke')).toBeNull();
    const halo = label.previousElementSibling;
    expect(halo?.textContent).toBe('Budget €10.00');
    expect(halo?.getAttribute('stroke')).toBe('var(--m-surface)');
    expect(halo?.getAttribute('aria-hidden')).toBe('true');
    expect([halo?.getAttribute('x'), halo?.getAttribute('y')]).toEqual([label.getAttribute('x'), label.getAttribute('y')]);
  });

  it('without value labels the chart keeps its old shape', () => {
    render(<Bars testId="plain" values={[5, 10]} />);
    expect(screen.getByTestId('plain').querySelectorAll('text')).toHaveLength(0);
    expect(screen.queryByTestId('plain-selected')).toBeNull();
  });
});
