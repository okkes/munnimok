import { aheadColor } from '@/domain/planning';
import { AHEAD_COLOR } from './planningUi';

/**
 * The circle (#128): how many periods ahead are funded, against the
 * rhythm's suggestion. It fills clockwise and shifts colour as it fills —
 * grey (nothing), green (one), orange (two), red (three or more: money
 * that could work harder) — the fill animates between states.
 */
export function AheadCircle({
  count,
  suggested,
  size = 64,
  label,
  testId,
  onClick,
}: Readonly<{
  count: number;
  suggested: number;
  size?: number;
  /** the caption under the fraction */
  label?: string;
  testId?: string;
  onClick?: () => void;
}>) {
  const stroke = size >= 56 ? 6 : 4;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const fraction = suggested > 0 ? Math.min(1, count / suggested) : 0;
  const color = AHEAD_COLOR[aheadColor(count)];
  const shown = Number.isInteger(count) ? String(count) : count.toFixed(1);
  const body = (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={radius} fill="none" stroke="var(--m-bg-2)" strokeWidth={stroke} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          style={{ transition: 'stroke-dashoffset 600ms ease-out, stroke 400ms ease-out' }}
        />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="m-num font-semibold" style={{ color, fontSize: size >= 56 ? 15 : 11 }} data-testid={testId ? `${testId}-count` : undefined}>
          {shown}/{suggested}
        </span>
        {label && size >= 56 && <span className="mt-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-4">{label}</span>}
      </span>
    </span>
  );
  if (!onClick) return <span data-testid={testId} data-color={aheadColor(count)}>{body}</span>;
  return (
    <button data-testid={testId} data-color={aheadColor(count)} onClick={onClick} className="m-tap border-none bg-transparent p-0" aria-label={label}>
      {body}
    </button>
  );
}
