import { useMemo } from 'react';
import { useData } from '@/app/data';
import { useQuery } from '@/db/useQuery';
import { reconnectNeedOf } from '@/domain/accountCoverage';
import type { ConnectionRenewal, ReachedBy, ReconnectNeed } from '@/domain/accountCoverage';
import type { AccountRow, ConnectorConnRow, StoreConnRow } from '@/db/types';
import { manageRouteFor, renewalOf } from './connectionRules';
import { partyName } from './logos';
import { CATALOGUE_META_KEY, useRelayAccountLinks, useRelayBindingsRead } from './useCatalogue';
import type { Cached } from './useCatalogue';
import type { BindingView, ProviderKind, ProviderManifest } from './types';

/** where a reconnect leads (#528): the connection itself, brought into view on the screen that manages it */
export interface ReconnectDoor {
  to: '/accounts' | '/connections';
  search: { connection?: string; uncovered?: string };
  /** what to call it: the connection's own name, or the party's when no connection is left */
  name: string;
}

export interface ReconnectReader {
  needOf: (account: AccountRow, owned: boolean | undefined) => ReconnectNeed | null;
  doorOf: (account: AccountRow, need: ReconnectNeed) => ReconnectDoor;
}

interface Inputs {
  metas: StoreConnRow[];
  devices: Map<string, ConnectorConnRow>;
  manifests: Map<string, ProviderManifest>;
}

/** builds the reader from what the device holds and what the relay said (S3776: out of the hook) */
function readerOf(inputs: Inputs, bindings: ReadonlyMap<string, BindingView> | undefined, reachedBy: ReachedBy | undefined): ReconnectReader {
  const live = new Map<string, ConnectionRenewal>();
  for (const meta of inputs.metas) {
    live.set(meta.id, renewalOf(meta, inputs.devices.get(meta.id), bindings?.get(meta.id), bindings !== undefined, inputs.manifests.get(meta.store)));
  }
  const metaById = new Map(inputs.metas.map((meta) => [meta.id, meta]));
  const partyKind = (provider: string | undefined): ProviderKind | undefined => (provider ? inputs.manifests.get(provider)?.kind : undefined);
  return {
    needOf: (account, owned) => reconnectNeedOf(account, owned, live, reachedBy),
    doorOf: (account, need) => {
      const party = account.provider ?? account.source;
      if (need.kind === 'signin') {
        const meta = metaById.get(need.connectionId);
        return { to: manageRouteFor(meta?.kind ?? partyKind(meta?.store)), search: { connection: need.connectionId }, name: meta?.displayName ?? partyName(party) };
      }
      return { to: manageRouteFor(partyKind(party)), search: { uncovered: account.id }, name: partyName(party) };
    },
  };
}

/**
 * #528: reads, per account, whether it needs its connection again — and
 * where to go about it. Undefined until the device's rows are read; the
 * relay's word (bindings, per-person account links) joins once it answers.
 */
export function useReconnectReader(): ReconnectReader | undefined {
  const { store } = useData();
  const inputs = useQuery(
    store,
    async (): Promise<Inputs> => {
      const metas = (await store.allRows('storeConn')).filter((c) => c.deleted === 0);
      const devices = new Map((await store.connectorConnAll()).map((d) => [d.id, d]));
      const cached = (await store.metaGet(CATALOGUE_META_KEY))?.value as Cached | undefined;
      return { metas, devices, manifests: new Map((cached?.catalogue.providers ?? []).map((p) => [p.id, p])) };
    },
    [],
  );
  // a connection made since the screen opened is asked about afresh, never read as one the relay dropped
  const liveKey = inputs ? inputs.metas.map((m) => m.id).sort((a, b) => a.localeCompare(b)).join(',') : '';
  const bindings = useRelayBindingsRead(liveKey);
  const reachedBy = useRelayAccountLinks(liveKey);
  return useMemo(() => (inputs ? readerOf(inputs, bindings, reachedBy) : undefined), [inputs, bindings, reachedBy]);
}
