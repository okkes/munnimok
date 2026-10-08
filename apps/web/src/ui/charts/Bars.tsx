import type { KeyboardEvent } from 'react';
/**
 * Minimal theme-aware SVG bar chart (trends design) — no library, the
 * bundle stays local-first-small. Bars are focusable for screen readers.
 */
/** #375: a tap or Enter/Space on a bar reports its index — only when the chart takes selections */
function barInteraction(onSelect: ((index: number) => void) | undefined, index: number) {
  if (!onSelect) return {};
  return {
    role: 'button',
    style: { cursor: 'pointer' },
    onClick: () => onSelect(index),
    onKeyDown: (e: KeyboardEvent<SVGGElement>) => {
      if (e.key === 'Enter' || e.key === ' ') onSelect(index);
    },
  };
}
/** a hollow (forecast) bar is an outline in the series colour */
const barPaint = (hollow: boolean, color: string) =>
  hollow ? { fill: 'transparent', stroke: color, strokeWidth: 1.5 } : { fill: color, stroke: 'none', strokeWidth: 0 };

const suffixed = (testId: string | undefined, suffix: string): string | undefined => (testId ? `${testId}-${suffix}` : undefined);

/** the amount above a bar (user 2026-10-08: "actual numbers on top of
 *  each bar") — text wears ink, never the series colour; the selected
 *  bar's number reads a shade stronger so the pick shows in the figures too */
function ValueLabel({ x, y, text, selected }: Readonly<{ x: number; y: number; text: string; selected: boolean }>) {
  return (
    <text
      x={x}
      y={y}
      textAnchor="middle"
      fontSize={8.5}
      fontWeight={selected ? 600 : 400}
      fill={selected ? 'var(--m-ink)' : 'var(--m-ink-3)'}
      className="m-num"
    >
      {text}
    </text>
  );
}

interface BarProps {
  x: number;
  barW: number;
  zeroY: number;
  /** the upward bar's height */
  h: number;
  /** the paired downward bar's height (cash-flow view), if any */
  down?: number;
  hollow: boolean;
  selected: boolean;
  color: string;
  negativeColor: string;
  valueLabel?: string;
  label?: string;
  labelY: number;
  testId?: string;
}

/** one bar with its ring, its number on top and its x label */
function Bar({ x, barW, zeroY, h, down, hollow, selected, color, negativeColor, valueLabel, label, labelY, testId }: Readonly<BarProps>) {
  return (
    <>
      {selected && (
        <rect
          x={x - 2.5}
          y={zeroY - h - 2.5}
          width={barW + 5}
          height={h + 5}
          rx={5}
          fill="none"
          stroke="var(--m-ink-2)"
          strokeWidth={1.2}
          data-testid={suffixed(testId, 'selected')}
        />
      )}
      <rect x={x} y={zeroY - h} width={barW} height={h} rx={3} {...barPaint(hollow, color)} />
      {down !== undefined && <rect x={x} y={zeroY + 1} width={barW} height={down} rx={3} fill={negativeColor} opacity={0.85} />}
      {valueLabel && <ValueLabel x={x + barW / 2} y={zeroY - h - 4} text={valueLabel} selected={selected} />}
      {label && (
        <text x={x + barW / 2} y={labelY} textAnchor="middle" fontSize={8.5} fill="var(--m-ink-4)">
          {label}
        </text>
      )}
    </>
  );
}

export function Bars({
  values,
  labels,
  ariaLabels,
  color = 'var(--m-accent)',
  hollowLast = false,
  height = 140,
  average,
  negativeValues,
  negativeColor = 'var(--m-negative)',
  testId,
  onSelect,
  valueLabels,
  selectedIndex,
  decorative = false,
}: Readonly<{
  values: number[];
  /** short x labels, same length as values (sparse: empty strings ok) */
  labels?: string[];
  /** per-bar accessible label */
  ariaLabels?: string[];
  color?: string;
  /** the running (incomplete) period renders outlined */
  hollowLast?: boolean;
  height?: number;
  /** dashed reference line */
  average?: number;
  /** paired series drawn downward (cash-flow view) */
  negativeValues?: number[];
  negativeColor?: string;
  testId?: string;
  /** a tap on a bar (index into values) — the bars become buttons */
  onSelect?: (index: number) => void;
  /** formatted amounts drawn above each bar (same length as values) */
  valueLabels?: string[];
  /** the picked bar wears a ring (testid `<testId>-selected`) */
  selectedIndex?: number;
  /** a sparkline inside a door (Home): no focus stops, hidden from readers — the door's text carries the numbers */
  decorative?: boolean;
}>) {
  const n = values.length;
  if (n === 0) return null;
  const width = 320; // viewBox units; the svg itself is fluid
  const labelZone = labels ? 16 : 0;
  const gap = 6;
  const barW = (width - gap * (n + 1)) / n;
  const maxUp = Math.max(...values, average ?? 0, 1);
  const maxDown = Math.max(...(negativeValues ?? [0]), 0);
  const zeroY = negativeValues ? (height * maxUp) / (maxUp + maxDown || 1) : height;
  // the tallest bar leaves headroom: a little by default, a label's worth with numbers on top
  const headroom = valueLabels ? 0.86 : 0.96;
  const upScale = (maxUp > 0 ? zeroY / maxUp : 0) * headroom;
  const downScale = maxDown > 0 ? (height - zeroY) / maxDown : 0;
  const barHeight = (value: number, scale: number) => Math.max(value > 0 ? 2 : 0, value * scale);

  return (
    <svg
      viewBox={`0 0 ${width} ${height + labelZone}`}
      className="w-full"
      data-testid={testId}
      style={{ overflow: 'visible' }}
      aria-hidden={decorative || undefined}
    >
      {values.map((value, i) => {
        const x = gap + i * (barW + gap);
        return (
          <g
            key={x}
            tabIndex={decorative ? undefined : 0}
            aria-label={ariaLabels?.[i]}
            data-testid={suffixed(testId, `bar-${i}`)}
            {...barInteraction(onSelect, i)}
          >
            <Bar
              x={x}
              barW={barW}
              zeroY={zeroY}
              h={barHeight(value, upScale)}
              down={negativeValues ? barHeight(negativeValues[i], downScale) : undefined}
              hollow={hollowLast && i === n - 1}
              selected={selectedIndex === i}
              color={color}
              negativeColor={negativeColor}
              valueLabel={valueLabels?.[i]}
              label={labels?.[i]}
              labelY={height + labelZone - 4}
              testId={testId}
            />
          </g>
        );
      })}
      {average !== undefined && average > 0 && (
        <line
          x1={0}
          x2={width}
          y1={zeroY - average * upScale}
          y2={zeroY - average * upScale}
          stroke="var(--m-ink-4)"
          strokeWidth={1}
          strokeDasharray="4 3"
        />
      )}
    </svg>
  );
}
