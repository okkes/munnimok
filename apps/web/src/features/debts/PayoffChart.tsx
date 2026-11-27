import { AXIS_W, scaleTicks } from '@/ui/charts/MultiLine';
import { monotonePath } from '@/ui/charts/monotone';
import { useUserInk } from '@/ui/userInk';
import { axisFraction, hasTail } from '@/domain/debtPlan';
import type { ChartAxis, ChartTick, WalkPoint } from '@/domain/debtPlan';

// decorative: the svg is aria-hidden, the card around it carries the dates and amounts in text
// a walk that pays off ends where it lands (#513); long minimums tails are compressed (domain chartAxis)

const WIDTH = 320;
/** room for the r=4 landing dot and its surface ring, top and bottom */
const PAD = 7;
const PAD_X = 5;
const LABEL_ZONE = 16;
const LABEL_FONT = 9;
/** a figure or letter is about this wide at the labels' size: enough to tell that two labels would touch */
const LETTER_W = LABEL_FONT * 0.56;
const LABEL_GAP = 4;

type Anchor = 'start' | 'middle' | 'end';

export interface PayoffSeries {
  points: readonly WalkPoint[];
  /** it reaches zero at its last point (else it never does and runs to the axis end) */
  landed: boolean;
  color: string;
  dashed?: boolean;
  testId?: string;
}

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

interface Label {
  tick: ChartTick;
  x: number;
  anchor: Anchor;
}

const labelFrom = (label: Label): number => {
  const width = label.tick.label.length * LETTER_W;
  if (label.anchor === 'start') return label.x;
  return label.anchor === 'end' ? label.x - width : label.x - width / 2;
};

/** the labels that fit beside each other, left to right: one that would touch the label before it is left out (#698) */
export function fittingLabels(labels: readonly Label[]): Label[] {
  const kept: Label[] = [];
  let free = -Infinity;
  for (const label of labels) {
    const from = labelFrom(label);
    if (from < free) continue;
    kept.push(label);
    free = from + label.tick.label.length * LETTER_W + LABEL_GAP;
  }
  return kept;
}

export function PayoffChart({
  series: given,
  axis,
  ticks,
  height = 120,
  testId,
  scale,
}: Readonly<{
  series: readonly PayoffSeries[];
  axis: ChartAxis;
  ticks: readonly ChartTick[];
  height?: number;
  testId?: string;
  /** #698: names the chart's amounts on a scale at the left, in the short form its gutter has room for */
  scale?: (cents: number) => string;
}>) {
  const ink = useUserInk();
  const series = given.map((s) => ({ ...s, color: ink(s.color) }));
  if (!series.some((s) => s.points.length > 1)) return null;
  // balances never go below zero: the scale runs from the zero line to the biggest opening balance
  const top = Math.max(1, ...series.flatMap((s) => s.points.map((point) => point.value)));
  const left = scale ? AXIS_W : 0;
  const plot = WIDTH - left - 2 * PAD_X;
  const x = (month: number) => left + PAD_X + axisFraction(axis, month) * plot;
  const y = (value: number) => height - PAD - (Math.max(0, value) / top) * (height - 2 * PAD);
  const zero = y(0);
  const suffixed = (suffix: string) => (testId ? `${testId}-${suffix}` : undefined);
  // a label stands under its mark; only where it would leave the picture is it turned inward
  const anchorFor = (at: number, text: string): Anchor => {
    const half = (text.length * LETTER_W) / 2;
    if (at - half < 0) return 'start';
    return at + half > WIDTH ? 'end' : 'middle';
  };
  const labels = fittingLabels(ticks.map((tick) => ({ tick, x: x(tick.month), anchor: anchorFor(x(tick.month), tick.label) })));
  return (
    <svg viewBox={`0 0 ${WIDTH} ${height + LABEL_ZONE}`} className="w-full" aria-hidden data-testid={testId}>
      {scale && (
        <g data-testid={suffixed('scale')}>
          {scaleTicks(0, top).map((value) => (
            <g key={value}>
              {value > 0 && <line x1={left} x2={WIDTH} y1={y(value)} y2={y(value)} stroke="var(--m-line-2)" strokeWidth={1} />}
              <text x={left - 5} y={y(value) + 3} textAnchor="end" fontSize={8} fill="var(--m-ink-4)" className="m-num">
                {scale(value)}
              </text>
            </g>
          ))}
        </g>
      )}
      <line x1={left} y1={zero} x2={WIDTH} y2={zero} stroke="var(--m-line)" strokeWidth={1} strokeDasharray="3 3" />
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
            {!s.dashed && <circle cx={end.x} cy={end.y} r={4} fill={s.color} stroke="var(--m-surface)" strokeWidth={2} />}
            {s.dashed && s.landed && (
              <circle cx={end.x} cy={end.y} r={3} fill={s.color} stroke="var(--m-surface)" strokeWidth={1.5} data-testid={s.testId ? `${s.testId}-end` : undefined} />
            )}
          </g>
        );
      })}
      <g data-testid={suffixed('marks')}>
        {labels.map((label) => (
          <text key={`t${label.tick.month}`} x={label.x} y={height + LABEL_ZONE - 3} textAnchor={label.anchor} fontSize={LABEL_FONT} fill="var(--m-ink-4)">
            {label.tick.label}
          </text>
        ))}
      </g>
    </svg>
  );
}
