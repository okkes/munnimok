import { useEffect, useRef, useState } from 'react';

/** #500: quick — a hop to the neighbour is a blink, a trip across the chart stays under half a second */
const MIN_MS = 160;
const MAX_MS = 380;
const MS_PER_STEP = 18;

/** how long a glide over `distance` index steps takes */
export const glideDuration = (distance: number): number => Math.min(MAX_MS, MIN_MS + Math.abs(distance) * MS_PER_STEP);

/** where a glide from `from` to `to` stands at `progress` (0…1) — eased out: it leaves fast and settles */
export function glideAt(from: number, to: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return from + (to - from) * (1 - (1 - p) ** 3);
}

/** tests snap (the sheets do the same); reduced motion snaps everywhere */
function motionAllowed(): boolean {
  if (import.meta.env.MODE === 'test') return false;
  return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/**
 * A chart marker that travels instead of jumping (#500, user: "as if the
 * dot is moving over the line to the clicked destination"): the returned
 * fractional index eases toward `target`, and a new target mid-flight
 * turns the marker from where it is. A marker that appears (null before)
 * starts at `origin` when one is given, else right at the target; the
 * first render never glides. `snap` follows a dragging finger directly —
 * a scrubber that trailed the finger read as lag.
 */
export function useGlide(target: number | null, origin?: number, snap = false): number | null {
  const [pos, setPos] = useState<number | null>(target);
  const current = useRef<number | null>(target);
  useEffect(() => {
    if (target === null) {
      current.current = null;
      setPos(null);
      return;
    }
    const start = current.current ?? origin ?? target;
    if (snap || start === target || !motionAllowed() || typeof requestAnimationFrame !== 'function') {
      current.current = target;
      setPos(target);
      return;
    }
    const duration = glideDuration(target - start);
    let begin: number | null = null;
    let frame = requestAnimationFrame(function step(now) {
      begin ??= now;
      const progress = (now - begin) / duration;
      const next = glideAt(start, target, progress);
      current.current = next;
      setPos(next);
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, origin, snap]);
  return pos;
}
