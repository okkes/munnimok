import type { PointerEvent } from 'react';

/** where an arrow key moves the scrubbed index (null = Escape clears, undefined = not a scrub key) */
export function scrubKeyTarget(key: string, current: number, count: number): number | null | undefined {
  if (key === 'ArrowLeft') return Math.max(0, current - 1);
  if (key === 'ArrowRight') return Math.min(count - 1, current + 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'Escape') return null;
  return undefined;
}

/** how far across the chart the pointer is, 0…1 — happy-dom lays nothing
 *  out, so a zero-width box reads as the left edge */
export function pointerFraction(e: PointerEvent<SVGSVGElement>): number {
  const rect = e.currentTarget.getBoundingClientRect();
  const fraction = rect.width > 0 ? (e.clientX - rect.left) / rect.width : 0;
  return Math.min(1, Math.max(0, fraction));
}
