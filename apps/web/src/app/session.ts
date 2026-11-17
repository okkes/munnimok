import { create } from 'zustand';
import { adoptedStoreKeys, getOfflineProfile } from '@/features/auth/offlineProfiles';

/** demo and offline identities never touch the network; user identities sync through the API (Logto, or test auth in e2e) */
export type Identity =
  | { kind: 'demo' }
  | { kind: 'offline'; profileId: string }
  | { kind: 'user'; sub: string; testAuth?: boolean };

// localStorage on purpose: a restart must not sign out, the data is on the device; Logto tokens live there too
// so background refresh survives restarts
const SS_KEY = 'munni_session';

export function readSessionIdentity(): Identity | null {
  try {
    const raw = localStorage.getItem(SS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Identity;
    if (parsed.kind === 'demo' || parsed.kind === 'offline' || parsed.kind === 'user') return parsed;
  } catch {
    // corrupted session — treat as signed out
  }
  return null;
}

export function identityKey(identity: Identity): string {
  switch (identity.kind) {
    case 'demo':
      return 'demo';
    case 'offline': {
      // a profile minted by "Go offline" adopted the former signed-in identity's store: its key points there
      const adopted = getOfflineProfile(identity.profileId)?.storeKey;
      return adopted ?? `offline_${identity.profileId}`;
    }
    case 'user':
      return userStoreKey(identity.sub);
  }
}

const USER_STORE_PREFIX = 'munni_user_store_';

// a login uses its last store unless "Go offline" handed it to a profile: the server gave the login a fresh account,
// and opening the old store as that account would wipe the profile's data
function userStoreKey(sub: string): string {
  // subs can contain chars unsafe for db names
  const base = `user_${sub.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const taken = adoptedStoreKeys();
  let key = localStorage.getItem(USER_STORE_PREFIX + base) ?? base;
  if (!taken.has(key)) return key;
  let n = 2;
  while (taken.has(key)) {
    key = `${base}_${n}`;
    n += 1;
  }
  // remembered: deleting the profile later must not send the login back to an empty first store
  localStorage.setItem(USER_STORE_PREFIX + base, key);
  return key;
}

interface SessionState {
  identity: Identity | null;
  login: (identity: Identity) => void;
  logout: () => void;
}

export const useSession = create<SessionState>((set) => ({
  identity: readSessionIdentity(),
  login: (identity) => {
    localStorage.setItem(SS_KEY, JSON.stringify(identity));
    set({ identity });
  },
  logout: () => {
    localStorage.removeItem(SS_KEY);
    set({ identity: null });
  },
}));
