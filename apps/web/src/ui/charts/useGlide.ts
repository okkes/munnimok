import { useEffect, useRef, useState } from 'react';

const MIN_MS = 160;
const MAX_MS = 380;
const MS_PER_STEP = 18;

export const glideDuration = (distance: number): number => Math.min(MAX_MS, MIN_MS + Math.abs(distance) * MS_PER_STEP);

export function glideAt(from: number, to: number, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  return from + (to - from) * (1 - (1 - p) ** 3);
}

/** tests snap (the sheets do the same); reduced motion snaps everywhere */
function motionAllowed(): boolean {
  if (import.meta.env.MODE === 'test') return false;
  return !(typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/** `snap` follows a dragging finger directly (a scrubber trailing it read as lag); the first render never glides (#500) */
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
