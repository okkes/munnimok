import { useQuery } from '@/db/useQuery';
import { useData } from './data';

/**
 * How many local writes still wait in the outbox for the server (user
 * 2026-10-06: "show me that there are unsynced changes on this device").
 * The outbox is a live table, so the count follows every write and every
 * push; a local-only identity keeps no outbox and counts zero.
 */
export function usePendingSync(): number {
  const { store, engine } = useData();
  const rows = useQuery(store, async () => (engine ? store.outboxAll() : []), [engine]);
  return rows?.length ?? 0;
}
