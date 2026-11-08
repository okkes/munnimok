// @vitest-environment happy-dom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AreaLine } from './AreaLine';
// harness registers RTL cleanup between tests
import '@/test/harness';

const points = [
  { date: '2026-06-01', cents: 100_000 },
  { date: '2026-06-02', cents: 90_000 },
  { date: '2026-06-03', cents: 80_000 },
  { date: '2026-06-04', cents: 300_000 },
  { date: '2026-06-05', cents: 290_000 },
];
const projection = [
  { date: '2026-06-05', cents: 290_000 },
  { date: '2026-06-08', cents: 250_000 },
  { date: '2026-06-10', cents: 250_000 },
];

function renderChart(onScrub = vi.fn()) {
  render(
    <AreaLine
      testId="al"
      points={points}
      projection={projection}
      markers={[{ date: '2026-06-04', text: 'Demo Corp' }]}
      labels={[{ date: '2026-06-01', text: '1 Jun' }]}
      todayLabel="Today"
      projectedLabel="expected"
      formatValue={(cents) => `€${cents / 100}`}
      formatDate={(date) => date}
      onScrub={onScrub}
    />,
  );
  const svg = screen.getByTestId('al');
  // happy-dom lays nothing out — the chart measures itself through this
  vi.spyOn(svg, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 320, top: 0, height: 160, right: 320, bottom: 160, x: 0, y: 0, toJSON: () => ({}) });
  return { svg, onScrub };
}

describe('AreaLine (user 2026-10-08: the filled balance line)', () => {
  it('draws the wash, the solid record, the dashed expectation after Today, the income label and the axis', () => {
    renderChart();
    expect(screen.getByTestId('al-area').getAttribute('d')).toMatch(/Z$/);
    expect(screen.getByTestId('al-line').getAttribute('stroke-dasharray')).toBeNull();
    expect(screen.getByTestId('al-projection').getAttribute('stroke-dasharray')).toBe('4 3');
    // the Today marker stands where the record ends: day 4 of 9 → 4/9 of the width
    const today = screen.getByTestId('al-today');
    expect(Number(today.getAttribute('x1'))).toBeCloseTo((4 / 9) * 320, 3);
    expect(screen.getByTestId('al').textContent).toContain('Today');
    expect(screen.getByTestId('al-marker-0').textContent).toBe('Demo Corp');
    expect(screen.getByTestId('al').textContent).toContain('1 Jun');
    expect(screen.queryByTestId('al-tip')).toBeNull();
  });

  it('two paydays close together keep both dots but only the first word (gallery 2026-10-08: the words printed on top of each other)', () => {
    // ten days on 320 units: a day is ~36 units, under the 48 a word needs
    const dense = Array.from({ length: 10 }, (_, i) => ({ date: `2026-06-${String(i + 1).padStart(2, '0')}`, cents: 100_000 + i * 1_000 }));
    render(
      <AreaLine
        testId="al2"
        points={dense}
        markers={[
          { date: '2026-06-01', text: 'Demo Corp' },
          { date: '2026-06-02', text: 'Demo Corp' },
          { date: '2026-06-04', text: 'Side job' },
        ]}
        todayLabel="Today"
        projectedLabel="expected"
        formatValue={(cents) => `€${cents / 100}`}
        formatDate={(date) => date}
      />,
    );
    // a day apart the second word would land on the first: its dot stays, its word goes
    expect(screen.getByTestId('al2-marker-0').textContent).toBe('Demo Corp');
    expect(screen.getByTestId('al2-marker-1').querySelector('circle')).toBeTruthy();
    expect(screen.getByTestId('al2-marker-1').textContent).toBe('');
    // three days further there is room again
    expect(screen.getByTestId('al2-marker-2').textContent).toBe('Side job');
  });

  it('a pointer over the chart scrubs the nearest day, into the expectation too, and lifts clean', () => {
    const { svg, onScrub } = renderChart();
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 0 });
    expect(screen.getByTestId('al-tip').textContent).toContain('2026-06-01');
    expect(screen.getByTestId('al-tip').textContent).toContain('€1000');
    expect(onScrub).toHaveBeenLastCalledWith({ date: '2026-06-01', cents: 100_000, projected: false });

    // the far right lands on the last expected day, marked as such
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 320 });
    expect(screen.getByTestId('al-tip').textContent).toContain('2026-06-10 · expected');
    expect(onScrub).toHaveBeenLastCalledWith({ date: '2026-06-10', cents: 250_000, projected: true });

    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(screen.queryByTestId('al-tip')).toBeNull();
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('the arrow keys walk the days from today; Escape clears', () => {
    const { svg, onScrub } = renderChart();
    fireEvent.keyDown(svg, { key: 'ArrowLeft' });
    expect(screen.getByTestId('al-tip').textContent).toContain('2026-06-04');
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    fireEvent.keyDown(svg, { key: 'ArrowRight' });
    expect(screen.getByTestId('al-tip').textContent).toContain('2026-06-08 · expected');
    fireEvent.keyDown(svg, { key: 'Escape' });
    expect(screen.queryByTestId('al-tip')).toBeNull();
    expect(onScrub).toHaveBeenLastCalledWith(null);
  });

  it('#501: below zero the balance turns red — one hard stop at the zero line paints the line, the wash and the expectation; the wash fills to zero', () => {
    const dipping = [
      { date: '2026-06-01', cents: 50_000 },
      { date: '2026-06-02', cents: -20_000 },
      { date: '2026-06-03', cents: -60_000 },
      { date: '2026-06-04', cents: 10_000 },
    ];
    render(
      <AreaLine testId="neg" points={dipping} projection={[{ date: '2026-06-06', cents: -5_000 }]} todayLabel="Today" projectedLabel="expected" formatValue={String} formatDate={String} />,
    );
    const svg = screen.getByTestId('neg');
    const stroke = screen.getByTestId('neg-line').getAttribute('stroke')!;
    expect(stroke).toMatch(/^url\(#al-/);
    expect(screen.getByTestId('neg-projection').getAttribute('stroke')).toBe(stroke);
    expect(screen.getByTestId('neg-area').getAttribute('fill')).toBe(stroke);
    const stops = [...svg.querySelectorAll('linearGradient stop')];
    expect(stops).toHaveLength(2);
    expect(stops[0].getAttribute('offset')).toBe(stops[1].getAttribute('offset'));
    expect((stops[1] as SVGElement).style.stopColor).toBe('var(--m-negative)');
    // the zero line is drawn, and the wash closes on it, not on the chart's floor
    const zeroY = screen.getByTestId('neg-zero').getAttribute('y1')!;
    expect(screen.getByTestId('neg-area').getAttribute('d')).toContain(`,${Number(zeroY).toFixed(1)} Z`);
    // today stands above zero: its dot keeps the series colour
    expect(screen.getByTestId('neg-now').getAttribute('fill')).toBe('var(--m-accent)');
  });

  it('#501: a balance that never goes under zero keeps its colour; one that stays under it is red throughout', () => {
    render(<AreaLine testId="pos" points={points} todayLabel="Today" projectedLabel="expected" formatValue={String} formatDate={String} />);
    expect(screen.getByTestId('pos-line').getAttribute('stroke')).toBe('var(--m-accent)');
    expect(screen.queryByTestId('pos-zero')).toBeNull();
    const under = points.map((point) => ({ ...point, cents: -point.cents }));
    render(<AreaLine testId="under" points={under} todayLabel="Today" projectedLabel="expected" formatValue={String} formatDate={String} />);
    expect(screen.getByTestId('under-line').getAttribute('stroke')).toBe('var(--m-negative)');
    expect(screen.getByTestId('under-now').getAttribute('fill')).toBe('var(--m-negative)');
    // its zero lies above the chart: the wash keeps to the floor
    expect(screen.getByTestId('under-area').getAttribute('d')).toMatch(/,160\.0 Z$/);
  });

  it('a single recorded day still renders (a dot, no paths) and nothing renders without data', () => {
    render(<AreaLine testId="one" points={[points[0]]} todayLabel="Today" projectedLabel="expected" formatValue={String} formatDate={String} />);
    expect(screen.queryByTestId('one-line')).toBeNull();
    expect(screen.getByTestId('one').querySelectorAll('circle')).toHaveLength(1);
    const { container } = render(<AreaLine testId="none" points={[]} todayLabel="Today" projectedLabel="expected" formatValue={String} formatDate={String} />);
    expect(container.querySelector('svg')).toBeNull();
  });
});
