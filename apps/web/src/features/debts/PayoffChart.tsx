import { monotonePath } from '@/ui/charts/monotone';
import { axisFraction, hasTail } from '@/domain/debtPlan';
import type { ChartAxis, ChartTick, WalkPoint } from '@/domain/debtPlan';

/**
 * The payoff planner's balance chart (user 2026-10-08): one line per walk
 * on a shared month axis — the plan solid, the minimums-only walk dashed
 * — over a dashed zero line, the debt-free line every walk aims for. A
 * walk that pays off ends where it lands (#513: no line running on along
 * zero): the plan with its dot, the minimums line with a smaller one, so
 * its end is always on the chart. When the minimums run on for decades
 * the axis breaks after the plan's months and the remaining years follow
 * compressed (domain chartAxis) — a break mark on the axis says so. The
 * x labels arrive as ticks, already thinned by the engine; the ones near
 * an edge anchor inward so no label ever clips. With an `amount`
 * formatter the scale gets its two cues — the top of the scale at the
 * top right, zero at the bottom left (user 2026-10-09: "I want to see how
 * much we are talking about") — each with a surface halo, so a line
 * crossing one stays readable. Decorative: the card around it carries the
 * dates and amounts in text, so the svg is hidden from assistive tech.
 */

const WIDTH = 320;
/** room for the r=4 landing dot and its surface ring, top and bottom */
const PAD = 7;
/** the same room left and right: an end dot on the edge stays whole */
const PAD_X = 5;
const LABEL_ZONE = 16;
/** a label within this share of the width from an edge anchors inward */
const EDGE = 0.08;
/** the amount cues' inset from the edge */
const CUE_INSET = 2;
const CUE_FONT = 9;

export interface PayoffSeries {
  /** the walk sampled onto the axis, today first */
  points: readonly WalkPoint[];
  /** it reaches zero at its last point (else it never does and runs to the axis end) */
  landed: boolean;
  color: string;
  dashed?: boolean;
  testId?: string;
}

/** the break between the even scale and the compressed tail: two slanted strokes across the zero line */
function AxisBreak({ x, zero, top, testId }: Readonly<{ x: number; zero: number; top: number; testId?: string }>) {
  return (
    <g data-testid={testId}>
      <line x1={x} y1={top} x2={x} y2={zero} stroke="var(--m-line)" strokeWidth={1} strokeDasharray="1 3" />
      <rect x={x - 4} y={zero - 4} width={8} height={8} fill="var(--m-surface)" />
      <line x1={x - 4} y1={zero + 3} x2={x - 1} y2={zero - 3} stroke="var(--m-ink-4)" strokeWidth={1} />
      <line x1={x + 1} y1={zero + 3} x2={x + 4} y2={zero - 3} stroke="var(--m-ink-4)" strokeWidth={1} />
    </g>
  );
}

function anchorFor(x: number): 'start' | 'middle' | 'end' {
  if (x <= WIDTH * EDGE) return 'start';
  if (x >= WIDTH * (1 - EDGE)) return 'end';
  return 'middle';
}

/** one amount cue on the scale, haloed in the surface colour so a line under it never swallows it */
function AmountCue({ x, y, anchor, text, testId }: Readonly<{ x: number; y: number; anchor: 'start' | 'end'; text: string; testId?: string }>) {
  return (
    <text
      x={x}
      y={y}
      textAnchor={anchor}
      fontSize={CUE_FONT}
      fill="var(--m-ink-4)"
      stroke="var(--m-surface)"
      strokeWidth={3}
      paintOrder="stroke"
      data-testid={testId}
    >
      {text}
    </text>
  );
}

export function PayoffChart({
  series,
  axis,
  ticks,
  height = 120,
  testId,
  amount,
}: Readonly<{
  series: readonly PayoffSeries[];
  axis: ChartAxis;
  ticks: readonly ChartTick[];
  height?: number;
  testId?: string;
  /** words an amount of cents for the scale's two cues; none = no cues */
  amount?: (cents: number) => string;
}>) {
  if (!series.some((s) => s.points.length > 1)) return null;
  // balances never go below zero: the scale runs from the zero line to the biggest opening balance
  const top = Math.max(1, ...series.flatMap((s) => s.points.map((point) => point.value)));
  const x = (month: number) => PAD_X + axisFraction(axis, month) * (WIDTH - 2 * PAD_X);
  const y = (value: number) => height - PAD - (Math.max(0, value) / top) * (height - 2 * PAD);
  const zero = y(0);
  const suffixed = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${height + LABEL_ZONE}`} className="w-full" aria-hidden data-testid={testId}>
      <line x1={0} y1={zero} x2={WIDTH} y2={zero} stroke="var(--m-line)" strokeWidth={1} strokeDasharray="3 3" />
      {ticks.map((tick) => (
        <line key={`m${tick.month}`} x1={x(tick.month)} y1={zero} x2={x(tick.month)} y2={zero + 4} stroke="var(--m-line)" strokeWidth={1} />
      ))}
      {hasTail(axis) && <AxisBreak x={x(axis.focusMonths)} zero={zero} top={PAD} testId={suffixed('break')} />}
      {series.map((s, si) => {
        if (s.points.length < 2) return null;
        const pts = s.points.map((point) => ({ x: x(point.month), y: y(point.value) }));
        const end = pts.at(-1)!;
        return (
          <g key={`${s.color}-${si}`}>
            <path
              d={monotonePath(pts)}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              strokeDasharray={s.dashed ? '5 4' : undefined}
              data-testid={s.testId}
            />
            {/* the plan's landing (or where it stands at the axis end); the minimums line's own end */}
            {!s.dashed && <circle cx={end.x} cy={end.y} r={4} fill={s.color} stroke="var(--m-surface)" strokeWidth={2} />}
            {s.dashed && s.landed && (
              <circle cx={end.x} cy={end.y} r={3} fill={s.color} stroke="var(--m-surface)" strokeWidth={1.5} data-testid={s.testId ? `${s.testId}-end` : undefined} />
            )}
          </g>
        );
      })}
      {amount && (
        <>
          <AmountCue x={WIDTH - CUE_INSET} y={y(top) + CUE_FONT + 1} anchor="end" text={amount(top)} testId={testId ? `${testId}-top` : undefined} />
          <AmountCue x={CUE_INSET} y={zero - 3} anchor="start" text={amount(0)} testId={testId ? `${testId}-zero` : undefined} />
        </>
      )}
      {ticks.map((tick) => (
        <text
          key={`t${tick.month}`}
          x={x(tick.month)}
          y={height + LABEL_ZONE - 3}
          textAnchor={anchorFor(x(tick.month))}
          fontSize={9}
          fill="var(--m-ink-4)"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  );
}
