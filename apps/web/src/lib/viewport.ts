import { useSyncExternalStore } from 'react';

/**
 * The one desktop breakpoint decision (redesign §4): at lg the app gains
 * side panels and master–detail panes. Shared so Sheet and SplitPane can
 * never disagree about where "desktop" begins.
 */
const LG_QUERY = '(min-width: 1024px)';

const subscribeLg = (listener: () => void) => {
  const mql = typeof window === 'undefined' ? undefined : window.matchMedia?.(LG_QUERY);
  mql?.addEventListener?.('change', listener);
  return () => mql?.removeEventListener?.('change', listener);
};
const readLg = () => (typeof window === 'undefined' ? false : (window.matchMedia?.(LG_QUERY)?.matches ?? false));

/** true on lg+ viewports; false during SSR and in unit tests */
export const useLgViewport = (): boolean => useSyncExternalStore(subscribeLg, readLg, () => false);
