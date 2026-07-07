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
  const profile: OfflineProfile = { id: uuidv7(), name: name.trim(), createdAt: Date.now() };
  localStorage.setItem(KEY, JSON.stringify([...listOfflineProfiles(), profile]));
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
