import { useQuery } from '@/db/useQuery';
import { useData } from '@/app/data';

/** one switch hides every ? button, first-time nudge and install hint; device meta, not space data */
export const TIPS_DISABLED_KEY = 'tipsDisabled';

export function useTipsDisabled(): boolean {
  const { store } = useData();
  return !!useQuery(store, async () => (await store.metaGet(TIPS_DISABLED_KEY))?.value, []);
}
