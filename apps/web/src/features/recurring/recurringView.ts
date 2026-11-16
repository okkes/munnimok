// module state: the range tab survives the list screen unmounting on mobile, resets on a fresh app start (#168)
export type RecurringView = 'period' | 'next' | 'year' | 'nextyear' | 'all';

let snapshot: RecurringView = 'period';

export const readRecurringView = (): RecurringView => snapshot;
export const writeRecurringView = (next: RecurringView): void => {
  snapshot = next;
};
/** specs share one module registry — reset between tests */
export const clearRecurringView = (): void => {
  snapshot = 'period';
};
