import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { ConnectorSessionState } from '@/db/types';
import { connectorApi } from './api';
import { subscribeConnectorFrames } from './events';
import { TERMINAL_STATES, failedWith } from './manifestForm';
import type { ErrorEnvelope, SessionView } from './types';

// the session runs on the platform whether or not the sheet is open, so closing DETACHES rather than cancels:
// the hub lists the login and a follower adopts it the moment it settles
// a module store: the sheet unmounts with the hub's state
export interface PendingLogin {
  connectionId: string;
  provider: string;
  sessionId: string;
  reconnect: boolean;
  startedAt: string;
  state: ConnectorSessionState;
  /** the party wants the person: a streamed page, a code, a redirect */
  asking: boolean;
  /** the run ended without a session — shown until dismissed */
  error?: ErrorEnvelope;
  /** a sheet follows this one: the hub's follower stands back (prod 2026-10-05: two pollers raced for the bundle) */
  attached?: boolean;
}

interface PendingState {
  logins: Record<string, PendingLogin>;
  put: (login: PendingLogin) => void;
  patch: (connectionId: string, fields: Partial<PendingLogin>) => void;
  remove: (connectionId: string) => void;
}

export const usePendingLogins = create<PendingState>((set) => ({
  logins: {},
  put: (login) => set((s) => ({ logins: { ...s.logins, [login.connectionId]: login } })),
  patch: (connectionId, fields) =>
    set((s) => (s.logins[connectionId] ? { logins: { ...s.logins, [connectionId]: { ...s.logins[connectionId], ...fields } } } : s)),
  remove: (connectionId) =>
    set((s) => {
      if (!s.logins[connectionId]) return s;
      const { [connectionId]: _gone, ...rest } = s.logins;
      return { logins: rest };
    }),
}));

export const pendingStateOf = (view: SessionView): Pick<PendingLogin, 'state' | 'asking' | 'error'> => ({
  state: view.state,
  asking: view.state === 'awaiting_input',
  error: TERMINAL_STATES.has(view.state) ? (view.error ?? failedWith(view.state)) : undefined,
});

export const pendingFromView = (login: Pick<PendingLogin, 'connectionId' | 'provider' | 'reconnect' | 'startedAt'>, view: SessionView): PendingLogin => ({
  ...login,
  sessionId: view.sessionId,
  ...pendingStateOf(view),
});

const FOLLOW_MS = 2_500;

// onActive adopts a settled login (the bundle is read exactly once, by the follower's view); a login whose sheet is
// open is left to the sheet, so one session is never read by two pollers
export function usePendingLoginFollower({
  exclude,
  onActive,
}: Readonly<{
  exclude: string | null;
  onActive: (login: PendingLogin, view: SessionView) => Promise<void>;
}>): void {
  const logins = usePendingLogins((s) => s.logins);
  const patch = usePendingLogins((s) => s.patch);
  const remove = usePendingLogins((s) => s.remove);
  const busy = useRef(new Set<string>());
  const settled = useRef(new Set<string>());
  const handler = useRef(onActive);
  handler.current = onActive;

  const ids = Object.values(logins)
    .filter((l) => l.connectionId !== exclude && !l.error && !l.attached)
    .map((l) => `${l.connectionId}|${l.provider}|${l.sessionId}`)
    .sort((a, b) => a.localeCompare(b))
    .join(',');

  useEffect(() => {
    if (!ids) return;
    const stops: (() => void)[] = [];
    for (const key of ids.split(',')) {
      const [connectionId, provider, sessionId] = key.split('|');
      const refresh = async () => {
        if (busy.current.has(connectionId) || settled.current.has(connectionId)) return;
        busy.current.add(connectionId);
        try {
          const view = await connectorApi.login(provider, sessionId);
          const login = usePendingLogins.getState().logins[connectionId];
          if (!login) return;
          if (view.state === 'active') {
            settled.current.add(connectionId);
            await handler.current(login, view);
            remove(connectionId);
            return;
          }
          patch(connectionId, pendingStateOf(view));
        } catch {
          // the relay is away: the next tick reads again
        } finally {
          busy.current.delete(connectionId);
        }
      };
      const unsubscribe = subscribeConnectorFrames(sessionId, () => void refresh());
      const timer = setInterval(() => void refresh(), FOLLOW_MS);
      void refresh();
      stops.push(() => {
        unsubscribe();
        clearInterval(timer);
      });
    }
    return () => {
      for (const stop of stops) stop();
    };
  }, [ids, patch, remove]);
}
