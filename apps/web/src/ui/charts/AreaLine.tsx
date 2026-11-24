/** Balance line: record solid, expectation dashed after Today; below zero it turns red (#501) and the wash fills to zero. */
import { useId, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { monotonePath, monotonePointAt } from './monotone';
import type { ChartPt } from './monotone';
import { scrubKeyTarget, useScrubPointer } from './scrub';
import { ScrubSlider } from './ScrubSlider';
import { useGlide } from './useGlide';
import { useUserInk } from '@/ui/userInk';

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
const NEGATIVE = 'var(--m-negative)';

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

function zeroPaint(split: number, color: string, gradientId: string): string {
  if (split >= 1) return color;
  if (split <= 0) return NEGATIVE;
  return `url(#${gradientId})`;
}

/** where the wash ends: the zero line while the chart holds it, else the chart's floor */
const washFloor = (zeroY: number, height: number): number => (zeroY >= TOP && zeroY <= height ? zeroY : height);

function nearestIndex(offsets: readonly number[], day: number): number {
  let best = 0;
  for (let i = 1; i < offsets.length; i++) {
    if (Math.abs(offsets[i] - day) < Math.abs(offsets[best] - day)) best = i;
  }
  return best;
}

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

/** a word needs this much of the viewBox: paydays a week apart printed on top of each other */
const MARKER_LABEL_GAP = 48;

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

function Markers({
  markers,
  points,
  x,
  y,
  colorOf,
  testId,
}: Readonly<{
  markers: readonly AreaLabel[];
  points: readonly AreaPoint[];
  x: (date: string) => number;
  y: (cents: number) => number;
  colorOf: (cents: number) => string;
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
            <circle cx={mx} cy={y(point.cents)} r={2.5} fill={colorOf(point.cents)} />
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
  color: picked = 'var(--m-accent)',
  height = 160,
  labels = [],
  markers = [],
  todayLabel,
  projectedLabel,
  formatValue,
  formatDate,
  onScrub,
  ariaLabel,
  sliderLabel,
  testId,
}: Readonly<{
  /** the record: one point per day, oldest first */
  points: readonly AreaPoint[];
  /** the expected path; its days after the last record day draw dashed */
  projection?: readonly AreaPoint[];
  color?: string;
  height?: number;
  labels?: readonly AreaLabel[];
  markers?: readonly AreaLabel[];
  todayLabel: string;
  projectedLabel: string;
  formatValue: (cents: number) => string;
  formatDate: (date: string) => string;
  onScrub?: (scrub: AreaScrub | null) => void;
  ariaLabel?: string;
  /** names the slider under the chart for a screen reader */
  sliderLabel?: string;
  testId?: string;
}>) {
  const color = useUserInk()(picked);
  const [scrub, setScrub] = useState<number | null>(null);
  // a landing finger glides the bead in from Today (#500); a drag follows directly
  const [dragging, setDragging] = useState(false);
  const gradientId = `al-${useId().replace(/[^\w-]/g, '')}`;
  const n = points.length;
  const scrubAt = useGlide(scrub, Math.max(0, n - 1), dragging);
  const lastDate = points.at(-1)?.date ?? '';
  const future = projection.filter((point) => point.date > lastDate);
  const all: AreaScrub[] = [
    ...points.map((point) => ({ ...point, projected: false })),
    ...future.map((point) => ({ ...point, projected: true })),
  ];
  const first = points[0]?.date ?? '';
  const totalDays = Math.max(1, dayDiff(first, all.at(-1)?.date ?? first));
  const offsets = all.map((point) => dayDiff(first, point.date));
  const pick = (index: number | null, follow = false) => {
    setDragging(follow);
    setScrub(index);
    onScrub?.(index === null ? null : all[index]);
  };
  const nearestTo = (day: number) => nearestIndex(offsets, day);
  const gesture = useScrubPointer({ indexAt: (fraction) => nearestTo(Math.round(fraction * totalDays)), pick, scrubbing: scrub !== null });
  if (n === 0) return null;
  const lastActual = points[n - 1];
  const x = (date: string) => (dayDiff(first, date) / totalDays) * WIDTH;
  const values = all.map((point) => point.cents);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const bottom = height - PAD;
  const y = (cents: number) => bottom - ((cents - min) / span) * (bottom - TOP);
  const labelZone = labels.length > 0 ? 16 : 0;

  const recordPts: ChartPt[] = points.map((point) => ({ x: x(point.date), y: y(point.cents) }));
  const projPts: ChartPt[] = future.length > 0 ? [lastActual, ...future].map((point) => ({ x: x(point.date), y: y(point.cents) })) : [];
  const linePath = n > 1 ? monotonePath(recordPts) : '';
  // #501: one hard stop at zero paints everything under it red; the wash fills to the zero line when the chart holds it,
  // else to the floor (an all-red line hanging from an unseen zero read as a mistake)
  const zeroY = y(0);
  const baseY = washFloor(zeroY, height);
  const areaPath = linePath ? `${linePath} L${fix(x(lastActual.date))},${fix(baseY)} L${fix(x(first))},${fix(baseY)} Z` : '';
  const projPath = projPts.length > 0 ? monotonePath(projPts) : '';
  const split = Math.min(1, Math.max(0, zeroY / height));
  const paint = zeroPaint(split, color, gradientId);
  const colorOf = (cents: number) => (cents < 0 ? NEGATIVE : color);
  const crossesZero = min < 0 && max > 0;
  const todayX = x(lastActual.date);
  const curveAt = (t: number): ChartPt => (t <= n - 1 ? monotonePointAt(recordPts, t) : monotonePointAt(projPts, t - (n - 1)));

  const onKeyDown = (e: KeyboardEvent<SVGSVGElement>) => {
    const target = scrubKeyTarget(e.key, scrub ?? n - 1, all.length);
    if (target === undefined) return;
    e.preventDefault();
    pick(target);
  };
  const dayText = (point: AreaScrub) => (point.projected ? `${formatDate(point.date)} · ${projectedLabel}` : formatDate(point.date));
  const scrubbed = scrub === null ? null : all[scrub];
  const bead = scrubbed && scrubAt !== null ? curveAt(scrubAt) : null;
  const sliderPoint = all[scrub ?? n - 1];

  return (
    <div>
      <svg
        ref={gesture.ref}
        viewBox={`0 0 ${WIDTH} ${height + labelZone}`}
        className="w-full outline-none"
        tabIndex={0}
        aria-label={ariaLabel}
        data-testid={testId}
        {...gesture.handlers}
        onKeyDown={onKeyDown}
        onBlur={() => pick(null)}
      >
        {paint.startsWith('url(') && (
          <defs>
            <linearGradient id={gradientId} gradientUnits="userSpaceOnUse" x1={0} y1={0} x2={0} y2={height}>
              <stop offset={split} style={{ stopColor: color }} />
              <stop offset={split} style={{ stopColor: NEGATIVE }} />
            </linearGradient>
          </defs>
        )}
        {crossesZero && (
          <line x1={0} x2={WIDTH} y1={zeroY} y2={zeroY} stroke="var(--m-ink-4)" strokeWidth={0.75} strokeDasharray="2 3" data-testid={suffixed(testId, 'zero')} />
        )}
        {areaPath && <path d={areaPath} fill={paint} fillOpacity={0.12} stroke="none" data-testid={suffixed(testId, 'area')} />}
        {linePath && (
          <path d={linePath} fill="none" stroke={paint} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" data-testid={suffixed(testId, 'line')} />
        )}
        {projPath && (
          <path
            d={projPath}
            fill="none"
            stroke={paint}
            strokeWidth={2}
            strokeLinecap="round"
            strokeDasharray="4 3"
            opacity={0.85}
            data-testid={suffixed(testId, 'projection')}
          />
        )}
        <line x1={todayX} x2={todayX} y1={TOP - 4} y2={height} stroke="var(--m-line)" strokeWidth={1} strokeDasharray="2 3" data-testid={suffixed(testId, 'today')} />
        <text x={todayX} y={10} textAnchor={edgeAnchor(todayX)} fontSize={8.5} fill="var(--m-ink-4)">
          {todayLabel}
        </text>
        <circle cx={todayX} cy={y(lastActual.cents)} r={3.5} fill={colorOf(lastActual.cents)} data-testid={suffixed(testId, 'now')} />
        <Markers markers={markers} points={points} x={x} y={y} colorOf={colorOf} testId={testId} />
        {labels.map((label) => (
          <text key={label.date} x={x(label.date)} y={height + labelZone - 4} textAnchor={edgeAnchor(x(label.date))} fontSize={8.5} fill="var(--m-ink-4)">
            {label.text}
          </text>
        ))}
        {scrubbed && bead && (
          <ScrubLayer
            sx={bead.x}
            sy={bead.y}
            height={height}
            color={bead.y > zeroY ? NEGATIVE : color}
            dateText={dayText(scrubbed)}
            valueText={formatValue(scrubbed.cents)}
            testId={testId}
          />
        )}
      </svg>
      {/* the slider walks days, not points: the expectation's points stand days apart, and the thumb keeps under the bead */}
      <ScrubSlider
        count={all.length > 1 ? totalDays + 1 : 1}
        value={dayDiff(first, sliderPoint.date)}
        rest={dayDiff(first, all[n - 1].date)}
        onPick={(day) => pick(day === null ? null : nearestTo(day), day !== null)}
        label={sliderLabel ?? ariaLabel}
        valueText={`${dayText(sliderPoint)}: ${formatValue(sliderPoint.cents)}`}
        color={color}
        testId={suffixed(testId, 'slider')}
      />
    </div>
  );
}
