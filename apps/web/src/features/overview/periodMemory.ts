// #355: the chosen period survives a category/transaction detour: module-level memo, session-scoped
// #454: Home's mount and every tab tap clear it (with the folds and offset); the detour screens never do
const overviewPeriods = new Map<string, number>();

const drillPeriods = new Map<string, number>();

/** the unfolded groups and the list's scroll offset survive a category detour too */
const overviewExpanded = new Map<string, Record<string, boolean>>();
const overviewScroll = new Map<string, number>();

export const recallPeriod = (kind: string): number | undefined => overviewPeriods.get(kind);

export function rememberPeriod(kind: string, index: number): void {
  overviewPeriods.set(kind, index);
}

export const recallDrillPeriod = (key: string): number | undefined => drillPeriods.get(key);

export function rememberDrillPeriod(key: string, index: number): void {
  drillPeriods.set(key, index);
}

const drillLinked = new Map<string, boolean>();

export const recallDrillLinked = (key: string): boolean | undefined => drillLinked.get(key);

export function rememberDrillLinked(key: string, on: boolean): void {
  drillLinked.set(key, on);
}

export const recallExpanded = (kind: string): Record<string, boolean> | undefined => overviewExpanded.get(kind);

export function rememberExpanded(kind: string, expanded: Record<string, boolean>): void {
  overviewExpanded.set(kind, expanded);
}

export const recallScroll = (kind: string): number | undefined => overviewScroll.get(kind);

export function rememberScroll(kind: string, top: number): void {
  overviewScroll.set(kind, top);
}

export function clearOverviewPeriods(): void {
  overviewPeriods.clear();
  drillPeriods.clear();
  drillLinked.clear();
  overviewExpanded.clear();
  overviewScroll.clear();
}
