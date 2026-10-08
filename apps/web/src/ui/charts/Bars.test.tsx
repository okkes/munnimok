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
    // the label sits ABOVE the bar it names
    const bar = screen.getByTestId('b-bar-2');
    const rect = bar.querySelectorAll('rect');
    const label = bar.querySelector('text')!;
    expect(Number(label.getAttribute('y'))).toBeLessThan(Number(rect[1].getAttribute('y')));
    // the ring wraps the picked bar only
    expect(screen.getByTestId('b-selected')).toBeTruthy();
    expect(screen.getByTestId('b-bar-0').querySelectorAll('rect')).toHaveLength(1);
    fireEvent.click(screen.getByTestId('b-bar-0'));
    expect(onSelect).toHaveBeenCalledWith(0);
  });

  it('without value labels the chart keeps its old shape', () => {
    render(<Bars testId="plain" values={[5, 10]} />);
    expect(screen.getByTestId('plain').querySelectorAll('text')).toHaveLength(0);
    expect(screen.queryByTestId('plain-selected')).toBeNull();
  });
});
