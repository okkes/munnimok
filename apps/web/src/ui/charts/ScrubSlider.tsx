import type { CSSProperties } from 'react';

/**
 * #510: the day scrub as a control under the chart, so reading a day never competes with scrolling the page.
 * The reading lasts while the thumb is held (or the slider has the keyboard), like a finger on the chart.
 */
export function ScrubSlider({
  count,
  value,
  onPick,
  label,
  valueText,
  color,
  plotFrom = 0,
  testId,
}: Readonly<{
  count: number;
  value: number;
  onPick: (index: number | null) => void;
  label?: string;
  valueText: string;
  /** the thumb wears the line's colour */
  color: string;
  /** where the chart's first point stands, as a share of its width (a value scale's gutter) */
  plotFrom?: number;
  testId?: string;
}>) {
  if (count < 2) return null;
  const release = () => onPick(null);
  // the thumb's centre travels between half a thumb in from each end: the margins put it under the chart's points
  const style = {
    '--m-scrub-ink': color,
    marginLeft: `calc(${(plotFrom * 100).toFixed(3)}% - var(--m-scrub-thumb) / 2)`,
    width: `calc(${((1 - plotFrom) * 100).toFixed(3)}% + var(--m-scrub-thumb))`,
  } as CSSProperties;
  return (
    <input
      type="range"
      className="m-scrub-range"
      min={0}
      max={count - 1}
      step={1}
      value={value}
      aria-label={label}
      aria-valuetext={valueText}
      data-testid={testId}
      style={style}
      onChange={(e) => onPick(Number(e.currentTarget.value))}
      onPointerUp={release}
      onTouchEnd={release}
      onTouchCancel={release}
      onBlur={release}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        release();
      }}
    />
  );
}
