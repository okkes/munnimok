/**
 * Tiny dependency-free chart primitives for the overview screens
 * (ported look from the legacy BarChart/StackedBar).
 */

interface BarChartProps {
  values: number[];
  labels: string[];
  selected: number;
  onSelect: (index: number) => void;
  height?: number;
  accent?: string;
}

/** selectable period bars with the value on top of the active bar */
export function BarChart({ values, labels, selected, onSelect, height = 90, accent = 'var(--m-accent)' }: BarChartProps) {
  const max = Math.max(...values.map((v) => Math.abs(v)), 1);
  return (
    <div className="flex items-end gap-1.5" style={{ height }} data-testid="overview-barchart">
      {values.map((value, i) => {
        const active = i === selected;
        const barHeight = Math.max((Math.abs(value) / max) * (height - 34), 3);
        return (
          <button
            key={labels[i]}
            data-testid={`overview-bar-${i}`}
            onClick={() => onSelect(i)}
            className="m-tap flex min-w-0 flex-1 flex-col items-center justify-end gap-1 border-none bg-transparent p-0"
            style={{ height: '100%' }}
          >
            <div
              className="w-full rounded-t-[4px]"
              style={{ height: barHeight, background: active ? accent : 'var(--m-line)', opacity: active ? 1 : 0.9 }}
            />
            <span className={`max-w-full truncate text-[9px] ${active ? 'font-semibold text-ink' : 'text-ink-4'}`}>
              {labels[i]}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface StackedBarProps {
  segments: { value: number; color: string }[];
  height?: number;
}

/** proportional composition bar (only positive contributions are drawn) */
export function StackedBar({ segments, height = 10 }: StackedBarProps) {
  const positive = segments.filter((s) => s.value > 0);
  const total = positive.reduce((sum, s) => sum + s.value, 0);
  if (total === 0) return <div className="w-full rounded-full bg-bg-2" style={{ height }} data-testid="overview-stackedbar" />;
  return (
    <div className="flex w-full overflow-hidden rounded-full" style={{ height }} data-testid="overview-stackedbar">
      {positive.map((s, i) => (
        // eslint-disable-next-line react/no-array-index-key -- purely visual, order-stable
        <div key={`${s.color}-${i}`} style={{ width: `${(s.value / total) * 100}%`, background: s.color }} />
      ))}
    </div>
  );
}
