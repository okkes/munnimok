/** Two-or-more series on one shared scale (#168: recurring year chart).
 *  Same fluid-width conventions as Line. #168 r2 (user): values may be
 *  null (a gap — segments span only consecutive non-null runs), lines
 *  are Catmull-Rom smoothed, `nowIndex` pins a vertical marker on the
 *  current period, and with `onPointClick` every point wears a
 *  tappable dot. Without `onPointClick` the chart stays decorative:
 *  aria-hidden, one end-dot per series. */

interface Pt {
  x: number;
  y: number;
}

const coords = (p: Pt) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;

/** uniform Catmull-Rom → cubic bezier; endpoints duplicate themselves */
function smoothPath(pts: readonly Pt[]): string {
  if (pts.length < 2) return '';
  const at = (i: number) => pts[Math.min(pts.length - 1, Math.max(0, i))];
  let d = `M${coords(pts[0])}`;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p0, p1, p2, p3] = [at(i - 1), at(i), at(i + 1), at(i + 2)];
    const c1: Pt = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2: Pt = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    d += ` C${coords(c1)} ${coords(c2)} ${coords(p2)}`;
  }
  return d;
}

interface Run {
  start: number;
  points: number[];
}

/** consecutive non-null stretches; a run of one renders as a lone dot */
function nonNullRuns(values: readonly (number | null)[]): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (value === null) continue;
    const prev = runs.at(-1);
    if (prev && prev.start + prev.points.length === i) prev.points.push(value);
    else runs.push({ start: i, points: [value] });
  }
  return runs;
}

export function MultiLine({
  series,
  labels,
  height = 140,
  testId,
  nowIndex,
  onPointClick,
  selected,
}: Readonly<{
  series: readonly { values: readonly (number | null)[]; color: string; dashed?: boolean }[];
  /** sparse x labels aligned with the longest series (empty strings skip) */
  labels?: string[];
  height?: number;
  testId?: string;
  /** vertical marker at this x index (#168 r2: the current period) */
  nowIndex?: number;
  /** interactive mode: every non-null point becomes a tappable dot */
  onPointClick?: (seriesIndex: number, pointIndex: number) => void;
  selected?: { seriesIndex: number; pointIndex: number } | null;
}>) {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (n === 0 || all.length === 0) return null;
  const width = 320;
  const labelZone = labels ? 16 : 0;
  const min = Math.min(...all, 0);
  const max = Math.max(...all, 0);
  const span = max - min || 1;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (value: number) => height - ((value - min) / span) * (height - 8) - 4;

  const interactiveDots = (si: number, color: string, runs: readonly Run[]) =>
    runs.flatMap((run) =>
      run.points.map((value, k) => {
        const i = run.start + k;
        const isSelected = selected?.seriesIndex === si && selected?.pointIndex === i;
        return (
          <g
            key={i}
            role="button"
            tabIndex={0}
            className="cursor-pointer outline-none"
            onClick={() => onPointClick?.(si, i)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onPointClick?.(si, i);
              }
            }}
          >
            <circle cx={x(i)} cy={y(value)} r={isSelected ? 4.5 : 3} fill={color} />
            {/* transparent hit target — a 3px dot is untappable */}
            <circle cx={x(i)} cy={y(value)} r={8} fill="transparent" data-testid={testId ? `${testId}-dot-${si}-${i}` : undefined} />
          </g>
        );
      }),
    );

  const endDot = (color: string, runs: readonly Run[]) => {
    const last = runs.at(-1);
    if (!last) return null;
    return <circle cx={x(last.start + last.points.length - 1)} cy={y(last.points.at(-1)!)} r={3} fill={color} />;
  };

  return (
    // without interaction the surrounding card carries the numbers in text
    <svg
      viewBox={`0 0 ${width} ${height + labelZone}`}
      className="w-full"
      aria-hidden={onPointClick ? undefined : true}
      data-testid={testId}
    >
      {nowIndex !== undefined && (
        <line
          x1={x(nowIndex)}
          y1={0}
          x2={x(nowIndex)}
          y2={height}
          stroke="var(--m-line)"
          strokeWidth={1}
          strokeDasharray="2 3"
          data-testid={testId ? `${testId}-now` : undefined}
        />
      )}
      {series.map((s, si) => {
        const runs = nonNullRuns(s.values);
        return (
          <g key={`s${s.color}-${si}`}>
            {runs.map(
              (run) =>
                run.points.length > 1 && (
                  <path
                    key={run.start}
                    d={smoothPath(run.points.map((value, k) => ({ x: x(run.start + k), y: y(value) })))}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? '5 4' : undefined}
                  />
                ),
            )}
            {onPointClick ? interactiveDots(si, s.color, runs) : endDot(s.color, runs)}
          </g>
        );
      })}
      {labels?.map((label, i) => {
        if (!label) return null;
        let anchor: 'start' | 'middle' | 'end' = 'middle';
        if (i === 0) anchor = 'start';
        else if (i === n - 1) anchor = 'end';
        return (
          <text key={x(i)} x={x(i)} y={height + labelZone - 4} textAnchor={anchor} fontSize={8.5} fill="var(--m-ink-4)">
            {label}
          </text>
        );
      })}
    </svg>
  );
}
