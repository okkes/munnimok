// @vitest-environment happy-dom
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SlideSwitch } from './SlideSwitch';
// harness registers RTL cleanup between tests
import '@/test/harness';

afterEach(() => {
  vi.useRealTimers();
});

const VIEWS = ['periods', 'compare', 'breakdown'];

function Card({ view, still }: Readonly<{ view: string; still?: boolean }>) {
  return (
    <SlideSwitch viewKey={view} index={VIEWS.indexOf(view)} testId="box" still={still}>
      <p data-testid={`view-${view}`}>{view}</p>
    </SlideSwitch>
  );
}

const slideOf = (testId: string) => screen.getByTestId(testId).parentElement as HTMLElement;

describe('SlideSwitch (#540: a card’s views change like pages scrolled sideways)', () => {
  it('a later tab pushes the old view out to the left and comes in from the right; then only the new view is left', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Card view="periods" still={false} />);
    expect(slideOf('view-periods').className).toBe('');

    rerender(<Card view="breakdown" still={false} />);
    const leaving = slideOf('view-periods');
    const entering = slideOf('view-breakdown');
    expect(leaving.className).toContain('m-slide-out');
    expect(leaving.getAttribute('aria-hidden')).toBe('true');
    expect(leaving.style.getPropertyValue('--m-slide-x')).toContain('-100%');
    expect(entering.className).toContain('m-slide-in');
    expect(entering.style.getPropertyValue('--m-slide-x')).toMatch(/^calc\(100%/);
    // the box clips sideways only while a view moves
    expect(entering.parentElement?.getAttribute('data-sliding')).toBe('true');

    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.queryByTestId('view-periods')).toBeNull();
    expect(slideOf('view-breakdown').className).toBe('');
    expect(slideOf('view-breakdown').parentElement?.getAttribute('data-sliding')).toBeNull();
  });

  it('an earlier tab does the opposite: the old view leaves to the right, the new one comes from the left', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Card view="breakdown" still={false} />);
    rerender(<Card view="compare" still={false} />);
    expect(slideOf('view-breakdown').style.getPropertyValue('--m-slide-x')).toMatch(/^calc\(100%/);
    expect(slideOf('view-compare').style.getPropertyValue('--m-slide-x')).toContain('-100%');
  });

  it('a view that leaves keeps what it showed: it is the same element, drawn once more', () => {
    vi.useFakeTimers();
    const { rerender } = render(<Card view="periods" still={false} />);
    const before = screen.getByTestId('view-periods');
    rerender(<Card view="compare" still={false} />);
    expect(screen.getByTestId('view-periods')).toBe(before);
  });

  it('standing still, the new view simply replaces the old one', () => {
    const { rerender } = render(<Card view="periods" still />);
    rerender(<Card view="compare" still />);
    expect(screen.queryByTestId('view-periods')).toBeNull();
    expect(slideOf('view-compare').className).toBe('');
  });
});
