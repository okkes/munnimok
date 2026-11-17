import type { ConnectorConnRow, StoreConnRow } from '@/db/types';
import type { ConnectionRenewal } from '@/domain/accountCoverage';
import type { BindingView, ProviderKind, ProviderManifest } from './types';

/** session states that only a new sign-in or consent leaves */
const ENDED = new Set<string>(['needs_reauth', 'expired', 'failed', 'disabled']);

// #528: the relay's binding is the word for a session it keeps; one it no longer keeps has ended
// the device row and synced status speak where the relay cannot (offline) or keeps nothing (own custody)
export function renewalOf(
  meta: Pick<StoreConnRow, 'status'>,
  device: Pick<ConnectorConnRow, 'state'> | undefined,
  binding: Pick<BindingView, 'state' | 'scheduled'> | undefined,
  bindingsKnown: boolean,
  manifest: Pick<ProviderManifest, 'unattendedFetch' | 'secretCustody'> | undefined,
): ConnectionRenewal {
  const unattended = manifest?.unattendedFetch ?? binding?.scheduled ?? false;
  if (binding) return { unattended, ended: ENDED.has(binding.state) };
  if (bindingsKnown && (manifest?.secretCustody === 'server' || manifest?.secretCustody === 'agent')) return { unattended, ended: true };
  return { unattended, ended: (device ? ENDED.has(device.state) : false) || meta.status === 'expired' };
}

/** the screen that manages a party's connections: banks live with the accounts (#527), shops and registries under Connected services */
export const manageRouteFor = (kind: ProviderKind | undefined): '/accounts' | '/connections' => (kind === 'store' || kind === 'registry' ? '/connections' : '/accounts');

// #548: connections synced by hand need the person at every sync (ING app approval, a shop's second step, a registry code)
// the manifest's `unattended_fetch` says so; Albert Heijn's refresh token and open-banking consents sync alone
export const syncsByHand = (meta: Pick<StoreConnRow, 'store'>, manifests: ReadonlyMap<string, Pick<ProviderManifest, 'unattendedFetch'>>): boolean =>
  manifests.get(meta.store)?.unattendedFetch === false;

export interface SyncableConnection {
  device?: Pick<ConnectorConnRow, 'state' | 'refreshedAt'>;
  hasBundle: boolean;
}

/** a session the party ends on its own clock is gone once that clock ran out: signing in again goes first */
export const sessionOver = (view: SyncableConnection, manifest: Pick<ProviderManifest, 'auth'> | undefined, now = Date.now()): boolean => {
  if (!view.hasBundle || view.device?.state !== 'active') return true;
  const ttl = manifest?.auth.session.ttlSeconds;
  if (!ttl || manifest.auth.session.refreshable || !view.device.refreshedAt) return false;
  return Date.parse(view.device.refreshedAt) + ttl * 1000 <= now;
};
