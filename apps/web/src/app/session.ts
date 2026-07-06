import { create } from 'zustand';

/**
 * Who is using the app on this device. Demo and offline identities never
 * touch the network; user identities sync through the API (auth via Logto,
 * or header-based test auth in e2e).
 */
export type Identity =
  | { kind: 'demo' }
  | { kind: 'offline'; profileId: string }
  | { kind: 'user'; sub: string; testAuth?: boolean };

const SS_KEY = 'munni_session';

export function readSessionIdentity(): Identity | null {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Identity;
    if (parsed.kind === 'demo' || parsed.kind === 'offline' || parsed.kind === 'user') return parsed;
  } catch {
    // corrupted session — treat as signed out
  }
  return null;
}

/** Stable database identity string, e.g. 'demo', 'offline_<id>', 'user_<sub>'. */
export function identityKey(identity: Identity): string {
  switch (identity.kind) {
    case 'demo':
      return 'demo';
    case 'offline':
      return `offline_${identity.profileId}`;
    case 'user':
      // subs can contain chars unsafe for db names
      return `user_${identity.sub.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  }
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
