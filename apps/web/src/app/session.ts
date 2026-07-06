import { create } from 'zustand';

/**
 * Who is using the app on this device. Demo and offline identities never
 * touch the network; user identities (Logto) arrive in Phase 2.
 */
export type Identity = { kind: 'demo' } | { kind: 'offline'; profileId: string };

const SS_KEY = 'munni_session';

export function readSessionIdentity(): Identity | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Identity;
    if (parsed.kind === 'demo' || parsed.kind === 'offline') return parsed;
  } catch {
    // corrupted session — treat as signed out
  }
  return null;
}

/** Stable database identity string, e.g. 'demo' or 'offline_<id>'. */
export function identityKey(identity: Identity): string {
  return identity.kind === 'demo' ? 'demo' : `offline_${identity.profileId}`;
}

interface SessionState {
  identity: Identity | null;
  login: (identity: Identity) => void;
  logout: () => void;
}

export const useSession = create<SessionState>((set) => ({
  identity: readSessionIdentity(),
  login: (identity) => {
    sessionStorage.setItem(SS_KEY, JSON.stringify(identity));
    set({ identity });
  },
  logout: () => {
    sessionStorage.removeItem(SS_KEY);
    set({ identity: null });
  },
}));
