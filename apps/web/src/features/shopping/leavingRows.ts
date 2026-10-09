import { useEffect, useMemo, useRef, useState } from 'react';

/**
 * Rows that leave with an exit animation (user 2026-10-09: "animate the
 * disappearance — right now it happens so instantly I'm not sure I
 * clicked"): an answered row is marked leaving, its write runs at once,
 * and the row keeps its place for the animation's length even when the
 * live query has already dropped it; one whose exit ended stays hidden
 * until the live query drops it too, so a slow write never shows it
 * popping back.
 */
export interface LeavingRow<T> {
  item: T;
  leaving: boolean;
}

interface Ghost<T> {
  item: T;
  /** where the row stood when it was answered — a ghost keeps that place */
  index: number;
  /** the exit animation has played out */
  done: boolean;
}

/** the live rows and the ones on their way out, in order */
export function withLeaving<T extends { id: string }>(live: readonly T[], ghosts: ReadonlyMap<string, Ghost<T>>): LeavingRow<T>[] {
  const rows: LeavingRow<T>[] = [];
  for (const item of live) {
    const ghost = ghosts.get(item.id);
    if (!ghost?.done) rows.push({ item, leaving: !!ghost });
  }
  const liveIds = new Set(live.map((item) => item.id));
  const gone = [...ghosts.values()].filter((ghost) => !ghost.done && !liveIds.has(ghost.item.id)).sort((a, b) => a.index - b.index);
  for (const ghost of gone) rows.splice(Math.min(ghost.index, rows.length), 0, { item: ghost.item, leaving: true });
  return rows;
}

export function useLeavingRows<T extends { id: string }>(
  live: readonly T[] | undefined,
  exitMs: number,
): { rows: LeavingRow<T>[]; leave: (item: T, index: number, run: () => Promise<unknown>) => void } {
  const [ghosts, setGhosts] = useState<ReadonlyMap<string, Ghost<T>>>(() => new Map());
  // the synchronous guard: a second tap before the re-render disables the buttons must not write twice
  const inFlight = useRef(new Set<string>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) clearTimeout(timer);
    };
  }, []);
  const rows = useMemo(() => withLeaving(live ?? [], ghosts), [live, ghosts]);
  // a ghost whose exit ended and whose row the live query dropped is forgotten
  useEffect(() => {
    const liveIds = new Set((live ?? []).map((item) => item.id));
    const stale = [...ghosts].filter(([id, ghost]) => ghost.done && !liveIds.has(id)).map(([id]) => id);
    if (stale.length === 0) return;
    setGhosts((prev) => {
      const next = new Map(prev);
      for (const id of stale) {
        next.delete(id);
        inFlight.current.delete(id);
      }
      return next;
    });
  }, [live, ghosts]);
  const leave = (item: T, index: number, run: () => Promise<unknown>) => {
    if (inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setGhosts((prev) => new Map(prev).set(item.id, { item, index, done: false }));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setGhosts((prev) => {
        const ghost = prev.get(item.id);
        return ghost ? new Map(prev).set(item.id, { ...ghost, done: true }) : prev;
      });
    }, exitMs);
    timers.current.add(timer);
    void run().catch(() => undefined);
  };
  return { rows, leave };
}
