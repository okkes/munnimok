/**
 * #355: the chosen period of an overview survives the detour into a
 * category or a transaction — a module-level memo per kind (and per
 * category drill), session-scoped like the transaction filters.
 *
 * #454 (user): it does NOT survive leaving the overview for Home or for
 * another main tab — the next visit starts at the current period again.
 * Home's mount and every tab tap clear it; the detour screens never do.
 */
const overviewPeriods = new Map<string, number>();

const drillPeriods = new Map<string, number>();

/** user ss 2026-10-06: the unfolded groups and the list's scroll offset
 *  survive the detour into a category too — back lands where you left,
 *  with the group you came from still open */
const overviewExpanded = new Map<string, Record<string, boolean>>();
const overviewScroll = new Map<string, number>();

/** the overview's remembered period index for a kind, if any */
export const recallPeriod = (kind: string): number | undefined => overviewPeriods.get(kind);

export function rememberPeriod(kind: string, index: number): void {
  overviewPeriods.set(kind, index);
}

/** a category drill's remembered period index, if any */
export const recallDrillPeriod = (key: string): number | undefined => drillPeriods.get(key);

export function rememberDrillPeriod(key: string, index: number): void {
  drillPeriods.set(key, index);
}

/** the overview's remembered fold state for a kind, if any */
export const recallExpanded = (kind: string): Record<string, boolean> | undefined => overviewExpanded.get(kind);

export function rememberExpanded(kind: string, expanded: Record<string, boolean>): void {
  overviewExpanded.set(kind, expanded);
}

/** the overview list's remembered scroll offset for a kind, if any */
export const recallScroll = (kind: string): number | undefined => overviewScroll.get(kind);

export function rememberScroll(kind: string, top: number): void {
  overviewScroll.set(kind, top);
}

/** Home's mount and every tab tap: the period, the folds and the offset
 *  all start fresh on the next visit (#454) */
export function clearOverviewPeriods(): void {
  overviewPeriods.clear();
  drillPeriods.clear();
  overviewExpanded.clear();
  overviewScroll.clear();
}
