import { useCallback, useEffect, useMemo, useState } from 'react';
import type { LabConfig } from '../config';
import { AgentsScreen } from '../features/agents/AgentsScreen';
import { BenchScreen } from '../features/bench/BenchScreen';
import { ConnectScreen } from '../features/bench/ConnectScreen';
import { SessionScreen } from '../features/bench/SessionScreen';
import { CanariesScreen } from '../features/canaries/CanariesScreen';
import { JobScreen } from '../features/jobs/JobScreen';
import { JobsScreen } from '../features/jobs/JobsScreen';
import { DashboardScreen } from '../features/dashboard/DashboardScreen';
import { ProviderScreen } from '../features/providers/ProviderScreen';
import { ProvidersScreen } from '../features/providers/ProvidersScreen';
import { SettingsScreen } from '../features/settings/SettingsScreen';
import { createCall, reasonOf } from './api';
import type { Call } from './api';
import { forgetDevice } from './device';
import { hrefOf, useRoute } from './router';

export interface LabAppProps {
  config: LabConfig;
  /** null = test-auth mode (X-User-Sub header from the sub box) */
  getToken: (() => Promise<string | undefined>) | null;
  /** ends the Logto session (absent in test-auth mode) — a freshly granted admin role rides on the next token */
  signOut?: () => void;
}

/** what every screen gets: the api door, the action runner, and whether one is running */
export interface ScreenProps {
  call: Call;
  busy: boolean;
  /** runs a mutation: busy while it runs, the error strip on refusal; true when the api said yes */
  act: (fn: () => Promise<Response>) => Promise<boolean>;
}

// 'denied' = the api really said 403; 'unreachable' = the ping never got
// an answer (network/CORS/5xx) — one shared message made a blocked request
// read as "not an admin"; 'disconnected' = this browser's device was
// revoked from the account (410) — the next load registers anew
type Gate = 'loading' | 'ok' | 'denied' | 'unreachable' | 'disconnected';

const NAV: readonly (readonly [string, string])[] = [
  ['', 'Dashboard'],
  ['providers', 'Providers'],
  ['jobs', 'Jobs'],
  ['bench', 'Bench'],
  ['agents', 'Agents'],
  ['canaries', 'Canaries'],
  ['settings', 'Settings'],
];

const SUB_KEY = 'munni_lab_sub';

/**
 * munni lab (#441): the connector workbench — what every party and agent
 * is doing, the kill switch, the fleet, the canaries; later the test
 * bench, the recorder and the retention checks. Talks to /lab/* on the
 * environment's api (the admin scope, relayed to the control plane).
 * Deliberately shares no runtime code with the member app.
 */
export function LabApp({ config, getToken, signOut }: Readonly<LabAppProps>) {
  const [sub, setSub] = useState(() => localStorage.getItem(SUB_KEY) ?? '');
  const call = useMemo(() => createCall(config.apiUrl, { getToken, sub }), [config.apiUrl, getToken, sub]);
  const [gate, setGate] = useState<Gate>('loading');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const route = useRoute();

  const probe = useCallback(async () => {
    const ping = await call('/lab/ping').catch(() => null);
    if (ping?.status === 410) {
      forgetDevice();
      setGate('disconnected');
      return;
    }
    if (ping?.status === 403) {
      setGate('denied');
      return;
    }
    setGate(ping?.ok ? 'ok' : 'unreachable');
  }, [call]);

  useEffect(() => {
    if (getToken || sub) void probe();
  }, [probe, getToken, sub]);

  const act = useCallback(async (fn: () => Promise<Response>) => {
    setBusy(true);
    setError(null);
    const res = await fn().catch(() => null);
    const ok = Boolean(res?.ok);
    if (!ok) setError(await reasonOf(res));
    setBusy(false);
    return ok;
  }, []);

  const section = route[0] ?? '';
  const screen: ScreenProps = { call, busy, act };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          munni<span className="dot">.</span> <span className="brand-sub">lab</span>
        </div>
        <nav>
          {NAV.map(([id, label]) => (
            <a key={id} href={hrefOf(id)} data-testid={`nav-${id || 'dashboard'}`} className={section === id ? 'active' : ''}>
              {label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          {signOut && (
            <button className="btn" data-testid="lab-signout" onClick={signOut}>
              Sign out
            </button>
          )}
          {!getToken && (
            <input
              data-testid="lab-sub"
              value={sub}
              placeholder="test subject (X-User-Sub)"
              onChange={(e) => {
                setSub(e.target.value);
                localStorage.setItem(SUB_KEY, e.target.value);
              }}
            />
          )}
        </div>
      </aside>

      <main className="content">
        {gate === 'denied' && (
          <p className="denied" data-testid="lab-denied">
            This account has no admin access yet — its sign-in carries no admin scope. An operator switches admin on for it in the setup
            wizard (the environment&apos;s Access tab); then sign out and in again — the role rides on the next token.
            {signOut && (
              <button className="btn" data-testid="lab-denied-signout" style={{ marginLeft: 12 }} onClick={signOut}>
                Sign out
              </button>
            )}
          </p>
        )}
        {gate === 'unreachable' && (
          <p className="denied" data-testid="lab-unreachable">
            The api did not answer — is the environment running (and this origin allowed)?
          </p>
        )}
        {gate === 'disconnected' && (
          <p className="denied" data-testid="lab-disconnected">
            This browser was disconnected from the account — reload to register it again.
          </p>
        )}
        {error && (
          <p className="error" data-testid="lab-error">
            {error}
          </p>
        )}
        {gate === 'ok' && section === '' && <DashboardScreen {...screen} />}
        {gate === 'ok' && section === 'providers' && route[1] === undefined && <ProvidersScreen {...screen} />}
        {gate === 'ok' && section === 'providers' && route[1] !== undefined && <ProviderScreen {...screen} id={route[1]} />}
        {gate === 'ok' && section === 'jobs' && route[1] === undefined && <JobsScreen {...screen} />}
        {gate === 'ok' && section === 'jobs' && route[1] !== undefined && <JobScreen {...screen} id={route[1]} />}
        {gate === 'ok' && section === 'bench' && route[1] === undefined && <BenchScreen {...screen} />}
        {gate === 'ok' && section === 'bench' && route[1] === 'connect' && route[2] !== undefined && <ConnectScreen {...screen} provider={route[2]} />}
        {gate === 'ok' && section === 'bench' && route[1] === 'sessions' && route[2] !== undefined && <SessionScreen {...screen} id={route[2]} />}
        {gate === 'ok' && section === 'agents' && <AgentsScreen {...screen} />}
        {gate === 'ok' && section === 'canaries' && <CanariesScreen {...screen} />}
        {gate === 'ok' && section === 'settings' && <SettingsScreen {...screen} config={config} testAuth={!getToken} />}
      </main>
    </div>
  );
}
