// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PayoffChart } from './PayoffChart';
// harness registers RTL cleanup between tests
import '@/test/harness';

describe('PayoffChart (user 2026-10-08)', () => {
  it('one path per series, the dashed one dashed, a landing dot on the solid one, one label per tick anchored inward at the edges', () => {
    render(
      <PayoffChart
        testId="pc"
        height={100}
        ticks={[
          { index: 0, label: '2026' },
          { index: 2, label: '2027' },
          { index: 4, label: '2028' },
        ]}
        series={[
          { values: [100, 80, 60, 40, 20], color: 'grey', dashed: true, testId: 'pc-base' },
          { values: [100, 50, 0, 0, 0], color: 'green', testId: 'pc-plan' },
        ]}
      />,
    );
    const svg = screen.getByTestId('pc');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByTestId('pc-base').getAttribute('stroke-dasharray')).toBe('5 4');
    expect(screen.getByTestId('pc-plan').getAttribute('stroke-dasharray')).toBeNull();
    // the one dot sits where the plan lands on zero: the third of five samples, half way across
    const dots = svg.querySelectorAll('circle');
    expect(dots).toHaveLength(1);
    expect(Number(dots[0].getAttribute('cx'))).toBe(160);
    const labels = [...svg.querySelectorAll('text')];
    expect(labels.map((el) => el.textContent)).toEqual(['2026', '2027', '2028']);
    expect(labels.map((el) => el.getAttribute('text-anchor'))).toEqual(['start', 'middle', 'end']);
    // decorative: the card beside it carries the numbers in text
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('a walk that never lands keeps its dot at the last sample; fewer than two samples draw nothing', () => {
    render(<PayoffChart testId="pc2" height={100} ticks={[]} series={[{ values: [100, 90, 80], color: 'green' }]} />);
    expect(Number(screen.getByTestId('pc2').querySelector('circle')?.getAttribute('cx'))).toBe(320);
    const { container } = render(<PayoffChart ticks={[]} series={[{ values: [100], color: 'green' }]} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
