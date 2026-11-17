import { v7 as uuidv7 } from 'uuid';
import { forgetNavCache } from '@/features/navigation/navCache';

/** fully local: no network, no sync; signing out keeps the profile and its data, only explicit deletion removes anything */
export interface OfflineProfile {
  id: string;
  name: string;
  createdAt: number;
  /** avatar preset id ("icon|color"), set from the profile screen */
  picture?: string;
  /** a profile born from "Go offline" ADOPTS the signed-in identity's store: this is that identity key (e.g. "user_abc") */
  storeKey?: string;
}

const KEY = 'munni_offline_profiles';

export function listOfflineProfiles(): OfflineProfile[] {
  try {
    const raw = localStorage.getItem(KEY);
    const parsed = raw ? (JSON.parse(raw) as OfflineProfile[]) : [];
    return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : [];
  } catch {
    return [];
  }
}

/** always a fresh profile: each is a fully separate world with its own store */
export function addOfflineProfile(name: string): OfflineProfile {
  const profile: OfflineProfile = { id: uuidv7(), name: name.trim(), createdAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify([...listOfflineProfiles(), profile]));
  return profile;
}

/** online→offline conversion: adopts the identity's store, no copying (the local-first store IS the data); nothing merges */
export function adoptOfflineProfile(name: string, picture: string | undefined, storeKey: string): OfflineProfile {
  const profile: OfflineProfile = { id: uuidv7(), name: name.trim() || 'munni', createdAt: Date.now(), picture, storeKey };
  localStorage.setItem(KEY, JSON.stringify([...listOfflineProfiles(), profile]));
  return profile;
}

/** the stores "Go offline" handed to a profile: no signed-in identity opens one again */
export function adoptedStoreKeys(): Set<string> {
  return new Set(listOfflineProfiles().flatMap((p) => (p.storeKey ? [p.storeKey] : [])));
}

export function offlineProfileName(id: string): string | undefined {
  return listOfflineProfiles().find((p) => p.id === id)?.name;
}

export function getOfflineProfile(id: string): OfflineProfile | undefined {
  return listOfflineProfiles().find((p) => p.id === id);
}

export function updateOfflineProfile(id: string, changes: Pick<Partial<OfflineProfile>, 'name' | 'picture'>): void {
  const updated = listOfflineProfiles().map((p) => (p.id === id ? { ...p, ...changes } : p));
  localStorage.setItem(KEY, JSON.stringify(updated));
}

// deletes the profile AND everything it owns: the identity database (Dexie or SQLCipher), the app-lock config,
// the registry row; irreversible
export async function deleteOfflineProfile(id: string): Promise<void> {
  const { destroyStorage } = await import('@/db/openStore');
  const { identityDbName } = await import('@/db/schema');
  // an adopted profile lives in the rebound store — destroy THAT one
  const key = getOfflineProfile(id)?.storeKey ?? `offline_${id}`;
  await destroyStorage(identityDbName(key)).catch(() => undefined);
  localStorage.removeItem(`munni_lock_${key}`);
  forgetNavCache(key);
  localStorage.setItem(KEY, JSON.stringify(listOfflineProfiles().filter((p) => p.id !== id)));
}
