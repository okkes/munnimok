/** null values are gaps (segments span consecutive non-null runs); without `onPointClick` the chart is decorative:
 *  aria-hidden, one end dot per series; `markerIndex` pins the tracking start (#168) */
import { useMemo, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { monotonePath, monotonePointAt } from './monotone';
import type { ChartPt } from './monotone';
import { pointerFraction, scrubKeyTarget } from './scrub';
import { useGlide } from './useGlide';
import { useUserInk } from '@/ui/userInk';

/** room for the selected dot (r=4.5 + 2px stroke): the peak's dot clipped the viewBox edge (#168) */
const PAD = 8;
const WIDTH = 320;
const TIP_W = 118;
const TIP_LINE = 11;
/** the gutter a value scale stands in: wide enough for "€12.5K" at the scale's size */
export const AXIS_W = 32;
/** a dot is 3 px: the finger and the pointer get this much around it, less only where the points stand closer */
const HIT_MAX = 14;
const HIT_MIN = 8;

/** the tap radius of a point: half the way to its neighbour, between the two limits */
export const hitRadius = (plotWidth: number, points: number): number =>
  Math.max(HIT_MIN, Math.min(HIT_MAX, points > 1 ? plotWidth / (points - 1) / 2 : HIT_MAX));

/** where a value scale puts its lines: the top, the bottom, and zero or the middle between them */
export function scaleTicks(min: number, max: number): number[] {
  if (max === min) return [max];
  const inner = min < 0 && max > 0 ? 0 : (min + max) / 2;
  return [max, inner, min];
}

type Values = readonly (number | null)[];

export interface ChartScrubRow {
  color: string;
  dashed?: boolean;
  text: string;
}

export interface ChartScrubTip {
  title: string;
  rows: readonly ChartScrubRow[];
}

export interface ChartScrub {
  origin: number;
  tip: (index: number) => ChartScrubTip;
  onScrub?: (index: number | null) => void;
  ariaLabel?: string;
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

function bandPath(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
  x: (i: number) => number,
  y: (value: number) => number,
): string {
  const shared: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const both = typeof a[i] === 'number' && typeof b[i] === 'number';
    if (!both) {
      if (shared.length > 0) break;
      continue;
    }
    shared.push(i);
  }
  if (shared.length < 2) return '';
  const top = monotonePath(shared.map((i) => ({ x: x(i), y: y(a[i] as number) })));
  const back = monotonePath([...shared].reverse().map((i) => ({ x: x(i), y: y(b[i] as number) })));
  return `${top} L${back.slice(1)} Z`;
}

/** the drawn curve of one series at fractional index `t` — null where no run of it spans that step */
function runPoint(values: Values, t: number, x: (i: number) => number, y: (value: number) => number): ChartPt | null {
  const lo = Math.floor(t);
  const hi = Math.ceil(t);
  const run = nonNullRuns(values).find((r) => r.start <= lo && hi < r.start + r.points.length);
  if (!run) return null;
  return monotonePointAt(
    run.points.map((value, k) => ({ x: x(run.start + k), y: y(value) })),
    t - run.start,
  );
}

// the marker rides the preferred series' curve, else whichever line spans the step (solid history and its dashed
// continuation meet in one point), else straight across a gap
function trackPoint(series: readonly { values: Values }[], prefer: number, t: number, x: (i: number) => number, y: (value: number) => number): ChartPt | null {
  const order = [prefer, ...series.map((_, si) => si).filter((si) => si !== prefer)];
  for (const si of order) {
    const point = runPoint(series[si]?.values ?? [], t, x, y);
    if (point) return point;
  }
  const at = (i: number): ChartPt | null => {
    for (const si of order) {
      const value = series[si]?.values[i];
      if (typeof value === 'number') return { x: x(i), y: y(value) };
    }
    return null;
  };
  const a = at(Math.floor(t));
  const b = at(Math.ceil(t));
  if (!a || !b) return a ?? b;
  const u = t - Math.floor(t);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

function ScrubLayer({
  series,
  at,
  tip,
  height,
  x,
  y,
  testId,
}: Readonly<{
  series: readonly { values: Values; color: string }[];
  at: number;
  tip: ChartScrubTip;
  height: number;
  x: (i: number) => number;
  y: (value: number) => number;
  testId?: string;
}>) {
  const gx = x(at);
  const dots = series.flatMap((s, si) => {
    const point = runPoint(s.values, at, x, y);
    return point ? [{ key: si, point, color: s.color }] : [];
  });
  const tipH = 8 + TIP_LINE * (tip.rows.length + 1);
  const topY = Math.min(height, ...dots.map((dot) => dot.point.y));
  const tipX = Math.min(Math.max(0, gx - TIP_W / 2), WIDTH - TIP_W);
  const above = topY - tipH - 8;
  const tipY = above < 0 ? Math.min(height - tipH, topY + 10) : above;
  return (
    <g pointerEvents="none" data-testid={testId ? `${testId}-scrub` : undefined}>
      <line x1={gx} x2={gx} y1={0} y2={height} stroke="var(--m-ink-3)" strokeWidth={1} strokeDasharray="3 3" />
      {dots.map((dot) => (
        <circle key={dot.key} cx={dot.point.x} cy={dot.point.y} r={4} fill={dot.color} stroke="var(--m-surface)" strokeWidth={2} />
      ))}
      <g transform={`translate(${tipX.toFixed(1)},${tipY.toFixed(1)})`} data-testid={testId ? `${testId}-tip` : undefined}>
        <rect width={TIP_W} height={tipH} rx={6} fill="var(--m-surface)" stroke="var(--m-line)" />
        <text x={8} y={12} fontSize={8.5} fill="var(--m-ink-3)">
          {tip.title}
        </text>
        {tip.rows.map((row, i) => (
          <g key={`${row.color}-${row.text}`} transform={`translate(8,${12 + TIP_LINE * (i + 1)})`}>
            <line x1={0} x2={10} y1={-3} y2={-3} stroke={row.color} strokeWidth={2} strokeDasharray={row.dashed ? '3 2' : undefined} />
            <text x={14} y={0} fontSize={9} fontWeight={600} fill="var(--m-ink)" className="m-num">
              {row.text}
            </text>
          </g>
        ))}
      </g>
    </g>
  );
}

function ChartDot({
  si,
  i,
  cx,
  cy,
  color,
  isSelected,
  onPick,
  hit,
  testId,
}: Readonly<{
  si: number;
  i: number;
  cx: number;
  cy: number;
  color: string;
  isSelected: boolean;
  onPick: (seriesIndex: number, pointIndex: number) => void;
  hit: number;
  testId?: string;
}>) {
  const activate = () => onPick(si, i);
  return (
    <g
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      className="group cursor-pointer outline-none"
      onClick={activate}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      }}
    >
      {/* #500: at rest every dot keeps its size (the selection is the marker gliding on top); under the pointer or the
          keyboard's focus it grows inside a halo, which says "this can be pressed" before anything is pressed */}
      <circle cx={cx} cy={cy} r={7} fill={color} pointerEvents="none" data-halo="" className="opacity-0 transition-opacity duration-150 group-hover:opacity-20 group-focus-visible:opacity-25" />
      <circle
        cx={cx}
        cy={cy}
        r={3}
        fill={color}
        data-dot=""
        className="origin-center transition-transform duration-150 [transform-box:fill-box] group-hover:scale-[1.7] group-focus-visible:scale-[1.7]"
      />
      {/* transparent hit target — a 3px dot is untappable */}
      <circle cx={cx} cy={cy} r={hit} fill="transparent" data-testid={testId} />
    </g>
  );
}

export function MultiLine({
  series: given,
  labels,
  height = 140,
  testId,
  markerIndex,
  onPointClick,
  selected,
  bandBetween,
  scrub,
  scale,
}: Readonly<{
  series: readonly {
    values: readonly (number | null)[];
    color: string;
    dashed?: boolean;
    /** the shared now-point renders ONE dot (the paid line owns it); the path still passes (#168) */
    skipDotAt?: number;
  }[];
  labels?: string[];
  height?: number;
  testId?: string;
  markerIndex?: number;
  onPointClick?: (seriesIndex: number, pointIndex: number) => void;
  selected?: { seriesIndex: number; pointIndex: number } | null;
  bandBetween?: readonly [number, number];
  scrub?: ChartScrub;
  /** #500: names the chart's own values on a scale at the left, so a line is not drawn in a void */
  scale?: (value: number) => string;
}>) {
  const ink = useUserInk();
  const series = useMemo(() => given.map((s) => ({ ...s, color: ink(s.color) })), [given, ink]);
  const [scrubbed, setScrubbed] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const scrubAt = useGlide(scrubbed, scrub?.origin, dragging);
  // #500: the selection is a marker that travels along the line to the tapped point
  const markerAt = useGlide(selected ? selected.pointIndex : null);
  const n = Math.max(0, ...series.map((s) => s.values.length));
  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (n === 0 || all.length === 0) return null;
  const width = WIDTH;
  const labelZone = labels ? 16 : 0;
  const min = Math.min(...all, 0);
  const max = Math.max(...all, 0);
  const span = max - min || 1;
  const axisZone = scale ? AXIS_W : 0;
  const plotWidth = width - axisZone;
  const x = (i: number) => axisZone + (n === 1 ? plotWidth / 2 : (i / (n - 1)) * plotWidth);
  const y = (value: number) => height - PAD - ((value - min) / span) * (height - 2 * PAD);
  const hit = hitRadius(plotWidth, n);
  const marker = selected && markerAt !== null ? trackPoint(series, selected.seriesIndex, markerAt, x, y) : null;

  const pickScrub = (index: number | null, follow: boolean) => {
    setDragging(follow);
    setScrubbed(index);
    scrub?.onScrub?.(index);
  };
  // the pointer is read across the whole picture; the points stand right of the scale's gutter
  const scrubIndexOf = (e: PointerEvent<SVGSVGElement>) =>
    Math.min(n - 1, Math.max(0, Math.round(((pointerFraction(e) * width - axisZone) / plotWidth) * (n - 1))));
  const scrubHandlers = scrub
    ? {
        tabIndex: 0,
        'aria-label': scrub.ariaLabel,
        style: { touchAction: 'none', cursor: 'crosshair' } as const,
        onPointerDown: (e: PointerEvent<SVGSVGElement>) => {
          e.currentTarget.setPointerCapture?.(e.pointerId);
          pickScrub(scrubIndexOf(e), false);
        },
        onPointerMove: (e: PointerEvent<SVGSVGElement>) => pickScrub(scrubIndexOf(e), scrubbed !== null),
        onPointerUp: () => pickScrub(null, false),
        onPointerCancel: () => pickScrub(null, false),
        onPointerLeave: () => pickScrub(null, false),
        onBlur: () => pickScrub(null, false),
        onKeyDown: (e: KeyboardEvent<SVGSVGElement>) => {
          const target = scrubKeyTarget(e.key, scrubbed ?? scrub.origin, n);
          if (target === undefined) return;
          e.preventDefault();
          pickScrub(target, false);
        },
      }
    : {};

  const handlePick = (si: number, i: number) => onPointClick?.(si, i);
  const interactiveDots = (si: number, color: string, runs: readonly Run[], skipDotAt?: number) =>
    runs.flatMap((run) =>
      run.points.flatMap((value, k) => {
        const i = run.start + k;
        if (i === skipDotAt) return [];
        return [
          <ChartDot
            key={i}
            si={si}
            i={i}
            cx={x(i)}
            cy={y(value)}
            color={color}
            isSelected={selected?.seriesIndex === si && selected?.pointIndex === i}
            onPick={handlePick}
            hit={hit}
            testId={testId ? `${testId}-dot-${si}-${i}` : undefined}
          />,
        ];
      }),
    );

  const endDot = (color: string, runs: readonly Run[]) => {
    const last = runs.at(-1);
    if (!last) return null;
    return <circle cx={x(last.start + last.points.length - 1)} cy={y(last.points.at(-1)!)} r={3} fill={color} />;
  };
  const band =
    bandBetween && series[bandBetween[0]] && series[bandBetween[1]]
      ? bandPath(series[bandBetween[0]].values, series[bandBetween[1]].values, x, y)
      : '';

  return (
    <svg
      viewBox={`0 0 ${width} ${height + labelZone}`}
      // a dot on the first or the last point stands on the picture's edge: it must not be cut there, least of all grown
      className="w-full overflow-visible outline-none"
      aria-hidden={onPointClick || scrub ? undefined : true}
      data-testid={testId}
      {...scrubHandlers}
    >
      {scale && (
        <g pointerEvents="none" data-testid={testId ? `${testId}-scale` : undefined}>
          {scaleTicks(min, max).map((tick) => (
            <g key={tick}>
              <line x1={axisZone} x2={width} y1={y(tick)} y2={y(tick)} stroke="var(--m-line-2)" strokeWidth={1} />
              <text x={axisZone - 5} y={y(tick) + 3} textAnchor="end" fontSize={8} fill="var(--m-ink-4)" className="m-num">
                {scale(tick)}
              </text>
            </g>
          ))}
        </g>
      )}
      {markerIndex !== undefined && (
        <line
          x1={x(markerIndex)}
          y1={0}
          x2={x(markerIndex)}
          y2={height}
          stroke="var(--m-line)"
          strokeWidth={1}
          strokeDasharray="2 3"
          data-testid={testId ? `${testId}-start` : undefined}
        />
      )}
      {band && bandBetween && (
        <path
          d={band}
          fill={series[bandBetween[0]].color}
          fillOpacity={0.12}
          stroke="none"
          pointerEvents="none"
          data-testid={testId ? `${testId}-band` : undefined}
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
                    d={monotonePath(run.points.map((value, k) => ({ x: x(run.start + k), y: y(value) })))}
                    fill="none"
                    stroke={s.color}
                    strokeWidth={2}
                    strokeLinejoin="round"
                    strokeLinecap="round"
                    strokeDasharray={s.dashed ? '5 4' : undefined}
                  />
                ),
            )}
            {onPointClick ? interactiveDots(si, s.color, runs, s.skipDotAt) : endDot(s.color, runs)}
          </g>
        );
      })}
      {marker && selected && (
        <circle
          cx={marker.x}
          cy={marker.y}
          r={4.5}
          fill={series[selected.seriesIndex]?.color ?? 'var(--m-accent)'}
          stroke="var(--m-surface)"
          strokeWidth={2}
          pointerEvents="none"
          data-testid={testId ? `${testId}-selected` : undefined}
        />
      )}
      {scrub && scrubbed !== null && scrubAt !== null && (
        <ScrubLayer series={series} at={scrubAt} tip={scrub.tip(scrubbed)} height={height} x={x} y={y} testId={testId} />
      )}
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
