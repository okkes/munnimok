// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AXIS_W } from '@/ui/charts/MultiLine';
import { PayoffChart, fittingLabels } from './PayoffChart';
// harness registers RTL cleanup between tests
import '@/test/harness';

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
    const planEnd = screen.getByTestId('pc-plan').getAttribute('d')!.split(' ').at(-1)!;
    expect(Number(planEnd.split(',')[0])).toBe(160);
    const dots = [...svg.querySelectorAll('circle')];
    expect(dots).toHaveLength(2);
    expect(Number(dots.find((dot) => dot.getAttribute('r') === '4')?.getAttribute('cx'))).toBe(160);
    expect(Number(screen.getByTestId('pc-base-end').getAttribute('cx'))).toBe(315);
    const labels = [...svg.querySelectorAll('text')];
    expect(labels.map((el) => el.textContent)).toEqual(['2026', '2027', '2028']);
    expect(labels.map((el) => el.getAttribute('text-anchor'))).toEqual(['start', 'middle', 'end']);
    expect(screen.queryByTestId('pc-break')).toBeNull();
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
    const lines = [...screen.getByTestId('pc5-break').querySelectorAll('line')];
    expect(Number(lines[0].getAttribute('x1'))).toBeCloseTo(5 + 0.72 * 310, 5);
    expect(Number(screen.getByTestId('pc5-base-end').getAttribute('cx'))).toBe(315);
  });

  it('#698: a scale names the top, the half and zero in a gutter at the left; the lines start right of it', () => {
    render(
      <PayoffChart
        testId="pc3"
        height={100}
        axis={{ focusMonths: 2, totalMonths: 2 }}
        ticks={[{ month: 0, label: '2026' }]}
        scale={(cents) => `€${cents / 100}`}
        series={[
          { points: walk([40_000, 20_000, 0]), landed: true, color: 'grey', dashed: true },
          { points: walk([250_000, 100_000, 0]), landed: true, color: 'green', testId: 'pc3-plan' },
        ]}
      />,
    );
    const scale = screen.getByTestId('pc3-scale');
    const texts = [...scale.querySelectorAll('text')];
    expect(texts.map((el) => el.textContent)).toEqual(['€2500', '€1250', '€0']);
    expect(texts.every((el) => el.getAttribute('text-anchor') === 'end' && Number(el.getAttribute('x')) === AXIS_W - 5)).toBe(true);
    // the top stands at the top of the plot (pad = 7), zero on the zero line (height − pad = 93)
    expect(texts.map((el) => Number(el.getAttribute('y')))).toEqual([10, 53, 96]);
    expect([...scale.querySelectorAll('line')].map((el) => Number(el.getAttribute('x1')))).toEqual([AXIS_W, AXIS_W]);
    expect(screen.getByTestId('pc3-plan').getAttribute('d')).toMatch(new RegExp(`^M${AXIS_W + 5}\\.0,7\\.0 `));
    // with a gutter beside it the first mark's label stands under its mark
    expect(screen.getByTestId('pc3-marks').querySelector('text')?.getAttribute('text-anchor')).toBe('middle');
    render(<PayoffChart testId="pc4" height={100} axis={{ focusMonths: 2, totalMonths: 2 }} ticks={[]} series={[{ points: walk([100, 50, 0]), landed: true, color: 'green' }]} />);
    expect(screen.queryByTestId('pc4-scale')).toBeNull();
    expect(screen.getByTestId('pc4').querySelectorAll('text')).toHaveLength(0);
  });

  it('#698: a label that would touch the one before it is left out; its mark stays', () => {
    const at = (x: number, label: string, anchor: 'start' | 'middle' | 'end' = 'middle') => ({ tick: { month: x, label }, x, anchor });
    expect(fittingLabels([at(5, '2026', 'start'), at(30, '2028'), at(80, '2030'), at(108, '2032')]).map((l) => l.tick.label)).toEqual(['2026', '2030', '2032']);
    expect(fittingLabels([at(20, 'Nov ’26'), at(50, 'May ’27'), at(90, 'Nov ’27'), at(320, '2052', 'end')]).map((l) => l.tick.label)).toEqual(['Nov ’26', 'Nov ’27', '2052']);
    render(
      <PayoffChart
        testId="pc6"
        height={100}
        axis={{ focusMonths: 100, totalMonths: 100 }}
        ticks={[
          { month: 0, label: '2026' },
          { month: 5, label: '2027' },
          { month: 50, label: '2030' },
        ]}
        series={[{ points: walk([100, 50, 0]), landed: true, color: 'green' }]}
      />,
    );
    expect([...screen.getByTestId('pc6-marks').querySelectorAll('text')].map((el) => el.textContent)).toEqual(['2026', '2030']);
    expect(screen.getByTestId('pc6').querySelectorAll('line[y2="97"]')).toHaveLength(3);
  });
});
