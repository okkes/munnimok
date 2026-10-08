/** A filled line over calendar days (user 2026-10-08: the balance chart)
 *  — the actual series solid with the series colour washed under it,
 *  an expected path dashed after a "Today" marker, small labels where
 *  money came in, and a scrubber: a finger, a mouse or the arrow keys
 *  put a guide, a dot and a tooltip on any day and report it upward so
 *  the surrounding card can mirror the value in text. */
import { useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import { monotonePath } from './monotone';

export interface AreaPoint {
  /** yyyy-mm-dd */
  date: string;
  cents: number;
}

export interface AreaScrub extends AreaPoint {
  /** the day lies on the expected path, not on the record */
  projected: boolean;
}

export interface AreaLabel {
  date: string;
  text: string;
}

const WIDTH = 320;
const PAD = 8;
/** the plot's ceiling: room for the Today word and the income labels */
const TOP = 20;
const TIP_W = 108;
const TIP_H = 30;

/** ISO dates parse as UTC midnights — day diffs come out exact */
const dayDiff = (from: string, to: string): number => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

const fix = (v: number) => v.toFixed(1);

const suffixed = (testId: string | undefined, suffix: string): string | undefined => (testId ? `${testId}-${suffix}` : undefined);

/** edge labels anchor inward so they never clip the viewBox */
function edgeAnchor(x: number): 'start' | 'middle' | 'end' {
  if (x < 24) return 'start';
  if (x > WIDTH - 24) return 'end';
  return 'middle';
}

/** where an arrow key moves the scrubbed index (undefined = not a scrub key) */
function keyTarget(key: string, current: number, count: number): number | null | undefined {
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, current + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'Escape') return null;
  return undefined;
}

/** the day (offset from the first) under the pointer — happy-dom lays
 *  nothing out, so a zero-width box reads as the first day */
function pointerDay(e: PointerEvent<SVGSVGElement>, totalDays: number): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
  return Math.round(Math.min(1, Math.max(0, fraction)) * totalDays);
}

/** the index whose day offset lies nearest to `day` */
function nearestIndex(offsets: readonly number[], day: number): number {
  let best = 0;
  for (let i = 1; i < offsets.length; i++) {
    if (Math.abs(offsets[i] - day) < Math.abs(offsets[best] - day)) best = i;
  }
  return best;
}

/** the guide, the dot and the tooltip of the scrubbed day */
function ScrubLayer({
  sx,
  sy,
  height,
  color,
  dateText,
  valueText,
  testId,
}: Readonly<{ sx: number; sy: number; height: number; color: string; dateText: string; valueText: string; testId?: string }>) {
  const tipX = Math.min(Math.max(0, sx - TIP_W / 2), WIDTH - TIP_W);
  const above = sy - TIP_H - 10;
  const tipY = above < 0 ? sy + 12 : above;
  return (
    <g pointerEvents="none" data-testid={suffixed(testId, 'scrub')}>
      <line x1={sx} x2={sx} y1={TOP} y2={height} stroke="var(--m-ink-3)" strokeWidth={1} strokeDasharray="3 3" />
      <circle cx={sx} cy={sy} r={4.5} fill={color} stroke="var(--m-surface)" strokeWidth={2} />
      <g transform={`translate(${fix(tipX)},${fix(tipY)})`} data-testid={suffixed(testId, 'tip')}>
        <rect width={TIP_W} height={TIP_H} rx={6} fill="var(--m-surface)" stroke="var(--m-line)" />
        <text x={8} y={12} fontSize={8.5} fill="var(--m-ink-3)">
          {dateText}
        </text>
        <text x={8} y={24} fontSize={10.5} fontWeight={600} fill="var(--m-ink)" className="m-num">
          {valueText}
        </text>
      </g>
    </g>
  );
}

/** a word needs this much of the viewBox to itself — two paydays a week apart used to print on top of each other (gallery 2026-10-08) */
const MARKER_LABEL_GAP = 48;

/** the markers whose word is drawn: every dot stays, a word only where the previous one sits far enough left */
function labelledMarkers(markers: readonly AreaLabel[], points: readonly AreaPoint[], x: (date: string) => number): Set<string> {
  const shown = new Set<string>();
  let lastX = Number.NEGATIVE_INFINITY;
  for (const marker of markers) {
    const point = points.find((candidate) => candidate.date === marker.date);
    if (!point) continue;
    const mx = x(point.date);
    if (mx - lastX < MARKER_LABEL_GAP) continue;
    shown.add(marker.date);
    lastX = mx;
  }
  return shown;
}

/** the words above the line where money came in */
function Markers({
  markers,
  points,
  x,
  y,
  color,
  testId,
}: Readonly<{
  markers: readonly AreaLabel[];
  points: readonly AreaPoint[];
  x: (date: string) => number;
  y: (cents: number) => number;
  color: string;
  testId?: string;
}>) {
  const labelled = labelledMarkers(markers, points, x);
  return (
    <>
      {markers.map((marker, i) => {
        const point = points.find((candidate) => candidate.date === marker.date);
        if (!point) return null;
        const mx = x(point.date);
        return (
          <g key={marker.date} data-testid={suffixed(testId, `marker-${i}`)}>
            <circle cx={mx} cy={y(point.cents)} r={2.5} fill={color} />
            {labelled.has(marker.date) && (
              <text x={mx} y={Math.max(y(point.cents) - 7, 10)} textAnchor={edgeAnchor(mx)} fontSize={8.5} fill="var(--m-ink-3)">
                {marker.text}
              </text>
            )}
          </g>
        );
      })}
    </>
  );
}

export function AreaLine({
  points,
  projection = [],
  color = 'var(--m-accent)',
  height = 160,
  labels = [],
  markers = [],
  todayLabel,
  projectedLabel,
  formatValue,
  formatDate,
  onScrub,
  ariaLabel,
  testId,
}: Readonly<{
  /** the record: one point per day, oldest first */
  points: readonly AreaPoint[];
  /** the expected path; its days after the last record day draw dashed */
  projection?: readonly AreaPoint[];
  color?: string;
  height?: number;
  /** sparse x labels by date */
  labels?: readonly AreaLabel[];
  /** small words above the line at those days (income spikes) */
  markers?: readonly AreaLabel[];
  todayLabel: string;
  /** the tooltip's suffix on the expected path */
  projectedLabel: string;
  formatValue: (cents: number) => string;
  formatDate: (date: string) => string;
  /** the scrubbed day, or null when the finger lifts */
  onScrub?: (scrub: AreaScrub | null) => void;
  ariaLabel?: string;
  testId?: string;
}>) {
  const [scrub, setScrub] = useState<number | null>(null);
  const n = points.length;
  if (n === 0) return null;
  const lastActual = points[n - 1];
  const future = projection.filter((point) => point.date > lastActual.date);
  const all: AreaScrub[] = [
    ...points.map((point) => ({ ...point, projected: false })),
    ...future.map((point) => ({ ...point, projected: true })),
  ];
  const first = points[0].date;
  const totalDays = Math.max(1, dayDiff(first, all[all.length - 1].date));
  const offsets = all.map((point) => dayDiff(first, point.date));
  const x = (date: string) => (dayDiff(first, date) / totalDays) * WIDTH;
  const values = all.map((point) => point.cents);
  const min = Math.min(...values);
  const span = Math.max(...values) - min || 1;
  const bottom = height - PAD;
  const y = (cents: number) => bottom - ((cents - min) / span) * (bottom - TOP);
  const labelZone = labels.length > 0 ? 16 : 0;

  const linePath = n > 1 ? monotonePath(points.map((point) => ({ x: x(point.date), y: y(point.cents) }))) : '';
  const areaPath = linePath ? `${linePath} L${fix(x(lastActual.date))},${height} L${fix(x(first))},${height} Z` : '';
  const projPath = future.length > 0 ? monotonePath([lastActual, ...future].map((point) => ({ x: x(point.date), y: y(point.cents) }))) : '';
  const todayX = x(lastActual.date);

  const pick = (index: number | null) => {
    setScrub(index);
    onScrub?.(index === null ? null : all[index]);
  };
  const fromPointer = (e: PointerEvent<SVGSVGElement>) => pick(nearestIndex(offsets, pointerDay(e, totalDays)));
  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const target = keyTarget(e.key, scrub ?? n - 1, all.length);
    if (target === undefined) return;
    e.preventDefault();
    pick(target);
  };
  const scrubbed = scrub === null ? null : all[scrub];
  const scrubDate = scrubbed?.projected ? `${formatDate(scrubbed.date)} · ${projectedLabel}` : formatDate(scrubbed?.date ?? '');

  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${height + labelZone}`}
      className="w-full outline-none"
      style={{ touchAction: 'none', cursor: 'crosshair' }}
      tabIndex={0}
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture?.(e.pointerId);
        fromPointer(e);
      }}
      onPointerMove={fromPointer}
      onPointerUp={() => pick(null)}
      onPointerCancel={() => pick(null)}
      onPointerLeave={() => pick(null)}
      onKeyDown={onKeyDown}
      onBlur={() => pick(null)}
    >
      {areaPath && <path d={areaPath} fill={color} fillOpacity={0.12} stroke="none" data-testid={suffixed(testId, 'area')} />}
      {linePath && (
        <path d={linePath} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" data-testid={suffixed(testId, 'line')} />
      )}
      {projPath && (
        <path
          d={projPath}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray="4 3"
          opacity={0.85}
          data-testid={suffixed(testId, 'projection')}
        />
      )}
      {/* the Today marker: the record ends here, the expectation begins */}
      <line x1={todayX} x2={todayX} y1={TOP - 4} y2={height} stroke="var(--m-line)" strokeWidth={1} strokeDasharray="2 3" data-testid={suffixed(testId, 'today')} />
      <text x={todayX} y={10} textAnchor={edgeAnchor(todayX)} fontSize={8.5} fill="var(--m-ink-4)">
        {todayLabel}
      </text>
      <circle cx={todayX} cy={y(lastActual.cents)} r={3.5} fill={color} />
      <Markers markers={markers} points={points} x={x} y={y} color={color} testId={testId} />
      {labels.map((label) => (
        <text key={label.date} x={x(label.date)} y={height + labelZone - 4} textAnchor={edgeAnchor(x(label.date))} fontSize={8.5} fill="var(--m-ink-4)">
          {label.text}
        </text>
      ))}
      {scrubbed && (
        <ScrubLayer sx={x(scrubbed.date)} sy={y(scrubbed.cents)} height={height} color={color} dateText={scrubDate} valueText={formatValue(scrubbed.cents)} testId={testId} />
      )}
    </svg>
  );
}
