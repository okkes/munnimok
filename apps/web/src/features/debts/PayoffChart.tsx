import { monotonePath } from '@/ui/charts/monotone';
import type { ChartTick } from '@/domain/debtPlan';

/**
 * The payoff planner's balance chart (user 2026-10-08): one line per walk
 * on a shared month grid — the plan solid, the minimums-only walk dashed
 * — over a dashed zero line, the debt-free line every walk aims for. The
 * x labels arrive as ticks on the grid, already thinned by the engine,
 * and the ones near an edge anchor inward so no label ever clips. The
 * solid line wears a dot where it lands on zero (or at its last sample
 * when it never does). With an `amount` formatter the scale gets its two
 * cues — the top of the scale at the top right, zero at the bottom left,
 * the corners a falling line leaves empty (user 2026-10-09: "graphs
 * alone say little … I want to see how much we are talking about") —
 * each with a surface halo, so a flat line crossing one stays readable.
 * Decorative: the card around it carries the dates and amounts in text,
 * so the svg is hidden from assistive tech.
 */

const WIDTH = 320;
/** room for the r=4 landing dot and its surface ring, top and bottom */
const PAD = 7;
const LABEL_ZONE = 16;
/** a label within this share of the width from an edge anchors inward */
const EDGE = 0.08;
/** the amount cues' inset from the edge */
const CUE_INSET = 2;
const CUE_FONT = 9;

export interface PayoffSeries {
  /** one value per grid sample, index 0 today */
  values: readonly number[];
  color: string;
  dashed?: boolean;
  testId?: string;
}

/** the first sample where the walk is done, else the last one — the dot marks the landing */
function landingIndex(values: readonly number[]): number {
  const hit = values.findIndex((value) => value <= 0);
  return hit >= 0 ? hit : values.length - 1;
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
  ticks,
  height = 120,
  testId,
  amount,
}: Readonly<{
  series: readonly PayoffSeries[];
  ticks: readonly ChartTick[];
  height?: number;
  testId?: string;
  /** words an amount of cents for the scale's two cues; none = no cues */
  amount?: (cents: number) => string;
}>) {
  const n = Math.max(0, ...series.map((s) => s.values.length));
  if (n < 2) return null;
  // balances never go below zero: the scale runs from the zero line to the biggest opening balance
  const top = Math.max(1, ...series.flatMap((s) => s.values));
  const x = (i: number) => (i / (n - 1)) * WIDTH;
  const y = (value: number) => height - PAD - (Math.max(0, value) / top) * (height - 2 * PAD);
  const zero = y(0);
  return (
    <svg viewBox={`0 0 ${WIDTH} ${height + LABEL_ZONE}`} className="w-full" aria-hidden data-testid={testId}>
      <line x1={0} y1={zero} x2={WIDTH} y2={zero} stroke="var(--m-line)" strokeWidth={1} strokeDasharray="3 3" />
      {ticks.map((tick) => (
        <line key={`m${tick.index}`} x1={x(tick.index)} y1={zero} x2={x(tick.index)} y2={zero + 4} stroke="var(--m-line)" strokeWidth={1} />
      ))}
      {series.map((s, si) => {
        if (s.values.length < 2) return null;
        const pts = s.values.map((value, i) => ({ x: x(i), y: y(value) }));
        const landing = pts[landingIndex(s.values)];
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
            {!s.dashed && <circle cx={landing.x} cy={landing.y} r={4} fill={s.color} stroke="var(--m-surface)" strokeWidth={2} />}
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
          key={`t${tick.index}`}
          x={x(tick.index)}
          y={height + LABEL_ZONE - 3}
          textAnchor={anchorFor(x(tick.index))}
          fontSize={9}
          fill="var(--m-ink-4)"
        >
          {tick.label}
        </text>
      ))}
    </svg>
  );
}
