// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PayoffChart } from './PayoffChart';
// harness registers RTL cleanup between tests
import '@/test/harness';

/** a walk as the engine hands it over: one point per month */
const walk = (values: readonly number[]) => values.map((value, month) => ({ month, value }));
const EVEN = { focusMonths: 4, totalMonths: 4 };

describe('PayoffChart (user 2026-10-08)', () => {
  it('one path per series, the dashed one dashed; each line ends where it lands — the plan’s dot, the minimums’ end point; labels anchored inward at the edges', () => {
    render(
      <PayoffChart
        testId="pc"
        height={100}
        axis={EVEN}
        ticks={[
          { month: 0, label: '2026' },
          { month: 2, label: '2027' },
          { month: 4, label: '2028' },
        ]}
        series={[
          { points: walk([100, 80, 60, 40, 0]), landed: true, color: 'grey', dashed: true, testId: 'pc-base' },
          { points: walk([100, 50, 0]), landed: true, color: 'green', testId: 'pc-plan' },
        ]}
      />,
    );
    const svg = screen.getByTestId('pc');
    expect(svg.querySelectorAll('path')).toHaveLength(2);
    expect(screen.getByTestId('pc-base').getAttribute('stroke-dasharray')).toBe('5 4');
    expect(screen.getByTestId('pc-plan').getAttribute('stroke-dasharray')).toBeNull();
    // #513: the plan stops at its landing, half way across — no line running on along zero
    const planEnd = screen.getByTestId('pc-plan').getAttribute('d')!.split(' ').at(-1)!;
    expect(Number(planEnd.split(',')[0])).toBe(160);
    const dots = [...svg.querySelectorAll('circle')];
    expect(dots).toHaveLength(2);
    expect(Number(dots.find((dot) => dot.getAttribute('r') === '4')?.getAttribute('cx'))).toBe(160);
    // the minimums line's end is on the chart, inside the frame
    expect(Number(screen.getByTestId('pc-base-end').getAttribute('cx'))).toBe(315);
    const labels = [...svg.querySelectorAll('text')];
    expect(labels.map((el) => el.textContent)).toEqual(['2026', '2027', '2028']);
    expect(labels.map((el) => el.getAttribute('text-anchor'))).toEqual(['start', 'middle', 'end']);
    expect(screen.queryByTestId('pc-break')).toBeNull();
    // decorative: the card beside it carries the numbers in text
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('a walk that never lands keeps its dot at the axis end and its minimums line carries no end point; fewer than two samples draw nothing', () => {
    render(
      <PayoffChart
        testId="pc2"
        height={100}
        axis={{ focusMonths: 2, totalMonths: 2 }}
        ticks={[]}
        series={[
          { points: walk([100, 100, 100]), landed: false, color: 'grey', dashed: true, testId: 'pc2-base' },
          { points: walk([100, 90, 80]), landed: false, color: 'green' },
        ]}
      />,
    );
    expect(Number(screen.getByTestId('pc2').querySelector('circle[r="4"]')?.getAttribute('cx'))).toBe(315);
    expect(screen.queryByTestId('pc2-base-end')).toBeNull();
    const { container } = render(<PayoffChart axis={EVEN} ticks={[]} series={[{ points: walk([100]), landed: false, color: 'green' }]} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('a compressed tail breaks the axis where the plan’s even months end (#513)', () => {
    render(
      <PayoffChart
        testId="pc5"
        height={100}
        axis={{ focusMonths: 10, totalMonths: 100 }}
        ticks={[{ month: 100, label: '2034' }]}
        series={[
          { points: [{ month: 0, value: 100 }, { month: 10, value: 90 }, { month: 100, value: 0 }], landed: true, color: 'grey', dashed: true, testId: 'pc5-base' },
          { points: walk([100, 60, 20, 0]), landed: true, color: 'green' },
        ]}
      />,
    );
    // the even ten months take 72% of the drawable width; the break stands there
    const lines = [...screen.getByTestId('pc5-break').querySelectorAll('line')];
    expect(Number(lines[0].getAttribute('x1'))).toBeCloseTo(5 + 0.72 * 310, 5);
    expect(Number(screen.getByTestId('pc5-base-end').getAttribute('cx'))).toBe(315);
  });

  it('with an amount formatter the scale gets its cues — the top of the scale at the top right, zero at the bottom left, haloed and drawn over the lines (user 2026-10-09)', () => {
    render(
      <PayoffChart
        testId="pc3"
        height={100}
        axis={{ focusMonths: 2, totalMonths: 2 }}
        ticks={[{ month: 0, label: '2026' }]}
        amount={(cents) => `€${cents / 100}`}
        series={[
          { points: walk([40_000, 20_000, 0]), landed: true, color: 'grey', dashed: true },
          { points: walk([250_000, 100_000, 0]), landed: true, color: 'green', testId: 'pc3-plan' },
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
    render(<PayoffChart testId="pc4" height={100} axis={{ focusMonths: 2, totalMonths: 2 }} ticks={[]} series={[{ points: walk([100, 50, 0]), landed: true, color: 'green' }]} />);
    expect(screen.queryByTestId('pc4-top')).toBeNull();
    expect(screen.getByTestId('pc4').querySelectorAll('text')).toHaveLength(0);
  });
});
