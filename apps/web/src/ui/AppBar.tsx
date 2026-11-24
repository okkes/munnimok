import type { ReactNode } from 'react';

interface AppBarProps {
  title: ReactNode;
  sub?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  large?: boolean;
  /** the title wraps onto further lines instead of ending in an ellipsis; the side buttons stay on its first line */
  wrapTitle?: boolean;
}

export function AppBar({ title, sub, leading, trailing, large, wrapTitle }: AppBarProps) {
  if (large) {
    // the trailing icons share the title's row: detached top-right icons read as unrelated chrome
    return (
      <div className="shrink-0 px-5 pt-3 pb-2">
        <div className="flex min-h-10 items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            {leading}
            <h1 className="m-h1 truncate">{title}</h1>
          </div>
          <div className="flex shrink-0 items-center gap-1">{trailing}</div>
        </div>
        {sub && <div className="mt-1 text-xs text-ink-3">{sub}</div>}
      </div>
    );
  }
  if (wrapTitle) {
    // the 4px padding centres a single title line on the 36px buttons, as the one-line bar does
    return (
      <div className="flex shrink-0 items-start justify-between gap-2 px-4 pt-2 pb-3">
        <div className="flex w-14 items-center justify-start gap-1">{leading}</div>
        <div className="flex min-h-9 min-w-0 flex-1 flex-col justify-center py-1 text-center">
          <div className="m-h3 wrap-anywhere" data-testid="appbar-title">
            {title}
          </div>
          {sub && <div className="mt-px text-xs text-ink-3">{sub}</div>}
        </div>
        <div className="flex w-14 items-center justify-end gap-1">{trailing}</div>
      </div>
    );
  }
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 px-4 pt-2 pb-3">
      <div className="flex w-14 items-center justify-start gap-1">{leading}</div>
      <div className="min-w-0 flex-1 text-center">
        <div className="m-h3 overflow-hidden text-ellipsis whitespace-nowrap">{title}</div>
        {sub && <div className="mt-px text-xs text-ink-3">{sub}</div>}
      </div>
      <div className="flex w-14 items-center justify-end gap-1">{trailing}</div>
    </div>
  );
}

export function IconButton({
  children,
  label,
  filled,
  onClick,
  testId,
}: {
  children: ReactNode;
  label: string;
  filled?: boolean;
  onClick?: () => void;
  testId?: string;
}) {
  return (
    <button
      aria-label={label}
      data-testid={testId}
      onClick={onClick}
      className={`m-tap flex h-9 w-9 items-center justify-center rounded-full border-none text-ink ${
        filled ? 'border border-solid border-line bg-surface' : 'bg-transparent'
      }`}
    >
      {children}
    </button>
  );
}
