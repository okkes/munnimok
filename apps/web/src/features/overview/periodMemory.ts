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

export function clearOverviewPeriods(): void {
  overviewPeriods.clear();
  drillPeriods.clear();
}
