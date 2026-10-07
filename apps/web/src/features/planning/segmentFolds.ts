import type { PlanSegmentKind } from '@/db/types';

/** which segments of a space's planning are folded on THIS device (user 2026-10-07) */
const key = (spaceId: string) => `munni_plan_folds_${spaceId}`;

export function readFolds(spaceId: string): Set<PlanSegmentKind> {
  try {
    const raw = localStorage.getItem(key(spaceId));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? (parsed.filter((k) => typeof k === 'string') as PlanSegmentKind[]) : []);
  } catch {
    return new Set();
  }
}

export function writeFolds(spaceId: string, folds: ReadonlySet<PlanSegmentKind>): void {
  try {
    localStorage.setItem(key(spaceId), JSON.stringify([...folds]));
  } catch {
    // storage blocked: the folds live for this visit only
  }
}

export function toggleFold(folds: ReadonlySet<PlanSegmentKind>, kind: PlanSegmentKind): Set<PlanSegmentKind> {
  const next = new Set(folds);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  return next;
}
