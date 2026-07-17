import { useEffect, useState } from 'react';
import type { StorageBackend } from './backend';

/**
 * Live query over the storage seam (replaces dexie-react-hooks'
 * useLiveQuery on the way to E2): undefined while loading, then the
 * result, re-emitted on every relevant data change. Errors rethrow into
 * the render so boundaries see them — same contract as useLiveQuery.
 */
export function useQuery<T>(backend: StorageBackend, query: () => Promise<T>, deps: unknown[]): T | undefined {
  const [state, setState] = useState<{ value?: T; error?: unknown }>({});
  useEffect(
    () =>
      backend.subscribe(
        query,
        (value) => setState({ value }),
        (error) => setState({ error }),
      ),
    // the query closure is rebuilt every render — deps decide re-subscription
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [backend, ...deps],
  );
  if (state.error !== undefined) throw state.error;
  return state.value;
}
