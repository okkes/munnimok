import { useEffect, useMemo, useRef, useState } from 'react';

// an answered row keeps its place for the exit animation; once done it stays hidden until the live query drops it,
// so a slow write never shows it popping back
export interface LeavingRow<T> {
  item: T;
  leaving: boolean;
}

interface Ghost<T> {
  item: T;
  index: number;
  done: boolean;
}

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
