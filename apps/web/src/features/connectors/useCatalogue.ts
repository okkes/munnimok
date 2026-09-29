import { useCallback, useEffect, useMemo, useState } from 'react';
import { useData } from '@/app/data';
import { connectorsAvailable } from '@/application/connections';
import { ConnectorError, connectorApi } from './api';
import type { BindingView, Catalogue, ErrorEnvelope, ProviderManifest, RelayInfo } from './types';

/** what this environment runs: null when the relay is absent or the identity never calls out; undefined while asking */
export function useRelayInfo(): RelayInfo | null | undefined {
  const [info, setInfo] = useState<RelayInfo | null | undefined>(connectorsAvailable() ? undefined : null);
  useEffect(() => {
    if (!connectorsAvailable()) return;
    let alive = true;
    connectorApi
      .info()
      .then((value) => alive && setInfo(value))
      .catch(() => alive && setInfo(null));
    return () => {
      alive = false;
    };
  }, []);
  return info;
}

/**
 * The relay's own bindings, by connection id — what it last heard from a
 * session and whether it syncs the connection by itself (§5.5). Read once
 * per hub open; the device rows stay the truth for custody.
 */
export function useRelayBindings(): ReadonlyMap<string, BindingView> {
  const [bindings, setBindings] = useState<ReadonlyMap<string, BindingView>>(new Map());
  useEffect(() => {
    if (!connectorsAvailable()) return;
    let alive = true;
    connectorApi
      .sessions()
      .then((rows) => alive && setBindings(new Map(rows.map((row) => [row.connectionId, row]))))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return bindings;
}

/**
 * The catalogue as the relay serves it, kept in the identity's meta store
 * so the hub renders names and logos offline and the next fetch rides the
 * ETag. Demo and offline identities get an empty catalogue and no call.
 */
const META_KEY = 'connectorCatalogue';

interface Cached {
  etag: string | null;
  catalogue: Catalogue;
  at: string;
}

export interface CatalogueState {
  providers: ProviderManifest[];
  byId: ReadonlyMap<string, ProviderManifest>;
  /** the first load, or a refresh behind a cached copy */
  loading: boolean;
  error: ErrorEnvelope | null;
  reload: () => void;
}

interface Snapshot {
  catalogue: Catalogue | null;
  loading: boolean;
  error: ErrorEnvelope | null;
}

const UNREACHABLE: ErrorEnvelope = {
  code: 'provider_unavailable',
  retriable: true,
  userAction: 'retry',
  messageKey: 'connect.error.provider_unavailable',
};

export function useCatalogue(): CatalogueState {
  const { store } = useData();
  const [snapshot, setSnapshot] = useState<Snapshot>({ catalogue: null, loading: connectorsAvailable(), error: null });
  const [tick, setTick] = useState(0);

  const load = useCallback(async () => {
    if (!connectorsAvailable()) return;
    const cached = (await store.metaGet(META_KEY))?.value as Cached | undefined;
    if (cached) setSnapshot({ catalogue: cached.catalogue, loading: true, error: null });
    try {
      const fresh = await connectorApi.catalogue(cached?.etag ?? null);
      if (fresh) {
        await store.metaPut(META_KEY, { etag: fresh.etag, catalogue: fresh.catalogue, at: new Date().toISOString() } satisfies Cached);
        setSnapshot({ catalogue: fresh.catalogue, loading: false, error: null });
      } else {
        setSnapshot((s) => ({ ...s, loading: false }));
      }
    } catch (err) {
      const error = err instanceof ConnectorError ? err.envelope : UNREACHABLE;
      setSnapshot((s) => ({ catalogue: s.catalogue, loading: false, error }));
    }
  }, [store]);

  useEffect(() => {
    void load().catch(() => undefined);
  }, [load, tick]);

  return useMemo(() => {
    const providers = snapshot.catalogue?.providers ?? [];
    return {
      providers,
      byId: new Map(providers.map((p) => [p.id, p])),
      loading: snapshot.loading,
      error: snapshot.error,
      reload: () => setTick((n) => n + 1),
    };
  }, [snapshot]);
}
