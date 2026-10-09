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

  it('with an amount formatter the scale gets its cues — the top of the scale at the top right, zero at the bottom left, haloed and drawn over the lines (user 2026-10-09)', () => {
    render(
      <PayoffChart
        testId="pc3"
        height={100}
        ticks={[{ index: 0, label: '2026' }]}
        amount={(cents) => `€${cents / 100}`}
        series={[
          { values: [40_000, 20_000, 0], color: 'grey', dashed: true },
          { values: [250_000, 100_000, 0], color: 'green', testId: 'pc3-plan' },
        ]}
      />,
    );
    const svg = screen.getByTestId('pc3');
    const top = screen.getByTestId('pc3-top');
    const zero = screen.getByTestId('pc3-zero');
    // the biggest opening balance names the scale
    expect(top.textContent).toBe('€2500');
    expect(top.getAttribute('text-anchor')).toBe('end');
    expect(Number(top.getAttribute('x'))).toBe(318);
    expect(zero.textContent).toBe('€0');
    expect(zero.getAttribute('text-anchor')).toBe('start');
    // zero sits just above the zero line (height − pad = 93), the top cue just under the top of the scale (pad = 7)
    expect(Number(zero.getAttribute('y'))).toBe(90);
    expect(Number(top.getAttribute('y'))).toBe(17);
    expect(top.getAttribute('paint-order')).toBe('stroke');
    // over the lines: the cues come after the paths in the document
    const order = [...svg.querySelectorAll('path, text')].map((el) => el.tagName.toLowerCase());
    expect(order.indexOf('text')).toBeGreaterThan(order.lastIndexOf('path'));
    // the year tick still labels the axis beside them
    expect([...svg.querySelectorAll('text')].map((el) => el.textContent)).toEqual(['€2500', '€0', '2026']);
    // without a formatter there are no cues
    render(<PayoffChart testId="pc4" height={100} ticks={[]} series={[{ values: [100, 50, 0], color: 'green' }]} />);
    expect(screen.queryByTestId('pc4-top')).toBeNull();
    expect(screen.getByTestId('pc4').querySelectorAll('text')).toHaveLength(0);
  });
});
