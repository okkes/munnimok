import { useQuery } from '@/db/useQuery';
import { useData } from './data';

/** local writes still waiting in the outbox; a local-only identity keeps no outbox and counts zero */
export function usePendingSync(): number {
  const { store, engine } = useData();
  const waiting = useQuery(store, async () => (engine ? store.outboxSpaceIds() : []), [engine]);
  return waiting?.length ?? 0;
}
