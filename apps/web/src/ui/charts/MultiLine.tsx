/** Two-or-more series on one shared scale (#168: recurring year chart).
 *  Same fluid-width conventions as Line; series toggle off by passing
 *  fewer entries — the scale is computed from what is shown. */
export function MultiLine({
  series,
  labels,
  height = 140,
  testId,
}: Readonly<{
  series: readonly { values: number[]; color: string; dashed?: boolean }[];
  /** sparse x labels aligned with the longest series (empty strings skip) */
  labels?: string[];
  height?: number;
  testId?: string;
}>) {
  const shown = series.filter((s) => s.values.length > 0);
  const n = Math.max(0, ...shown.map((s) => s.values.length));
  if (n === 0 || shown.length === 0) return null;
  const width = 320;
  const labelZone = labels ? 16 : 0;
  const all = shown.flatMap((s) => s.values);
  const min = Math.min(...all, 0);
  const max = Math.max(...all, 0);
  const span = max - min || 1;
  const x = (i: number) => (n === 1 ? width / 2 : (i / (n - 1)) * width);
  const y = (value: number) => height - ((value - min) / span) * (height - 8) - 4;
  const pathFor = (values: number[]) =>
    values.map((value, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(value).toFixed(1)}`).join(' ');

  return (
    // decorative: the surrounding card carries the numbers in text
    <svg viewBox={`0 0 ${width} ${height + labelZone}`} className="w-full" aria-hidden data-testid={testId}>
      {shown.map((s, si) => (
        <g key={`s${s.color}-${si}`}>
          <path
            d={pathFor(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            strokeDasharray={s.dashed ? '5 4' : undefined}
          />
          <circle cx={x(s.values.length - 1)} cy={y(s.values[s.values.length - 1])} r={3} fill={s.color} />
        </g>
      ))}
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
