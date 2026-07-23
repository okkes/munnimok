import { v7 as uuidv7 } from 'uuid';

/**
 * Registry of offline profiles on this device (localStorage). Offline
 * mode is fully local: no network calls, no sync — signing out keeps the
 * profile and its data; only its explicit deletion removes anything.
 */
export interface OfflineProfile {
  id: string;
  name: string;
  createdAt: number;
  /** avatar preset id ("icon|color"), set from the profile screen */
  picture?: string;
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

export function addOfflineProfile(name: string): OfflineProfile {
  // ONE profile per device (user ruling): bookkeeping separates through
  // spaces, not parallel profiles — a second create returns the first
  const existing = listOfflineProfiles()[0];
  if (existing) return existing;
  const profile: OfflineProfile = { id: uuidv7(), name: name.trim(), createdAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify([profile]));
  return profile;
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

/**
 * Delete the profile AND everything it owns (user request — with one
 * profile per device, reinstalling was the only way out): the identity
 * database wherever it lives (Dexie or SQLCipher), the app-lock config
 * and the registry row. Irreversible by design.
 */
export async function deleteOfflineProfile(id: string): Promise<void> {
  const { destroyStorage } = await import('@/db/openStore');
  const { identityDbName } = await import('@/db/schema');
  await destroyStorage(identityDbName(`offline_${id}`)).catch(() => undefined);
  localStorage.removeItem(`munni_lock_offline_${id}`);
  localStorage.setItem(KEY, JSON.stringify(listOfflineProfiles().filter((p) => p.id !== id)));
}
