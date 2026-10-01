import { useCallback, useEffect, useState } from 'react';
import type { ControlConfig } from './config';

interface HealthInfo {
  build?: string;
  capabilities?: Record<string, unknown>;
}

/** the connector control plane's status as /control/connectors/status relays it (#367 M6; the parties' budget since #414) */
interface ConnectorProvider {
  providerId: string;
  state: string;
  since: string;
  reasonKey?: string | null;
  acceptsWork: boolean;
  quota?: { limit?: number | null; remaining?: number | null; resetAt?: string | null; seenAt?: string | null } | null;
}
interface ConnectorStatus {
  service: { kinds: string[]; version: string; manifestDigest: string };
  providers: ConnectorProvider[];
  agents: { total: number; online: number; revoked: number };
  queue: { queued: number; running: number; awaitingInput: number };
  relay?: { openStreams: number };
}
/** null = not asked yet; 'absent' = the designated environment runs no connectors (404); 'unreachable' = its control plane did not answer */
type ConnectorsView = ConnectorStatus | 'absent' | 'unreachable' | null;
/** one consent on an aggregator's account as the party lists it (§15.6), attributed by the environment it was started from */
interface RemoteConsent {
  id: string;
  status: string;
  createdAt?: string | null;
  institutionId?: string | null;
  origin?: string | null;
  accountCount: number;
}

type Screen = 'overview' | 'connectors';

const NAV: [Screen, string][] = [
  ['overview', 'Overview'],
  ['connectors', 'Connectors'],
];

/**
 * This browser's stable device id: the API stamps every authenticated
 * request's device (X-Munni-Device) and refuses requests that name none,
 * so the account's Logged-in devices screen can list and disconnect it.
 */
const DEVICE_KEY = 'munni_control_device';
function deviceId(): string {
  try {
    const known = localStorage.getItem(DEVICE_KEY);
    if (known) return known;
    const minted = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, minted);
    return minted;
  } catch {
    return 'control-console';
  }
}
function forgetDevice(): void {
  try {
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    // storage unavailable — nothing was remembered
  }
}

/** grouping key for consents whose return carried no usable origin */
const UNATTRIBUTED = 'unattributed';

/** consents per return origin, named environments first, unattributed last */
export function groupByOrigin(consents: RemoteConsent[]): [string, RemoteConsent[]][] {
  const groups = new Map<string, RemoteConsent[]>();
  for (const c of consents) {
    const key = c.origin ?? UNATTRIBUTED;
    const list = groups.get(key) ?? [];
    if (list.length === 0) groups.set(key, list);
    list.push(c);
  }
  return [...groups.entries()].sort(
    ([a], [b]) => Number(a === UNATTRIBUTED) - Number(b === UNATTRIBUTED) || a.localeCompare(b),
  );
}

const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');

/** the party's budget as one line: remaining of limit, when it resets — or nothing said yet */
export function quotaLine(quota: ConnectorProvider['quota']): string {
  if (!quota || (quota.limit == null && quota.remaining == null)) return '—';
  const left = `${quota.remaining ?? '?'} / ${quota.limit ?? '?'}`;
  return quota.resetAt ? `${left} · resets ${when(quota.resetAt)}` : left;
}

const quotaLow = (quota: ConnectorProvider['quota']): boolean =>
  quota?.remaining != null && quota.limit != null && quota.limit > 0 && quota.remaining <= quota.limit / 5;

interface ControlAppProps {
  config: ControlConfig;
  /** null = test-auth mode (X-User-Sub header from the sub box) */
  getToken: (() => Promise<string | undefined>) | null;
  /** ends the Logto session (absent in test-auth mode) — a freshly granted admin role rides on the next token */
  signOut?: () => void;
}

/**
 * munni control (admin split LS5/LS6): the shared-services cockpit — a
 * deliberately SEPARATE app from the per-environment admin portal. It
 * talks only to the /control/* surface of the designated environment's
 * API and is read-only across the board: the connector control plane's
 * parties with their budget, and — for an aggregator such as GoCardless,
 * whose one account serves every environment — the inventory of consents
 * attributed per environment (§15.6). Every write, the kill switch and a
 * consent's revocation included, stays in the environment's own admin portal.
 */
export function ControlApp({ config, getToken, signOut }: Readonly<ControlAppProps>) {
  // survives the full page reload a Logto re-auth causes (else every token
  // hiccup dumps the operator back on Overview mid-task)
  const [screen, setScreen] = useState<Screen>(() => {
    const saved = sessionStorage.getItem('munni_control_screen');
    return NAV.some(([id]) => id === saved) ? (saved as Screen) : 'overview';
  });
  const openScreen = (next: Screen) => {
    sessionStorage.setItem('munni_control_screen', next);
    setScreen(next);
  };
  const [sub, setSub] = useState(() => localStorage.getItem('munni_control_sub') ?? '');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [connectors, setConnectors] = useState<ConnectorsView>(null);
  // 'denied' = the api really said 403; 'unreachable' = the ping never
  // got an answer (network/CORS/5xx) — the two used to share one message
  // and a blocked request read as "not an admin" (found live 2026-08-28)
  const [denied, setDenied] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  // 'disconnected' = the api said 410: this browser's device was revoked
  // from the account (Logged-in devices) — the next load registers anew
  const [disconnected, setDisconnected] = useState(false);
  const blocked = denied || unreachable || disconnected;

  const call = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Content-Type', 'application/json');
      headers.set('X-Munni-Device', deviceId());
      headers.set('X-Munni-Platform', 'web');
      if (getToken) {
        const token = await getToken();
        if (token) headers.set('Authorization', `Bearer ${token}`);
      } else if (sub) {
        headers.set('X-User-Sub', sub);
      }
      return fetch(`${config.apiUrl}${path}`, { ...init, headers });
    },
    [config.apiUrl, getToken, sub],
  );

  const reload = useCallback(async () => {
    const ping = await call('/control/ping').catch(() => null);
    if (ping?.status === 410) {
      forgetDevice();
      setDisconnected(true);
      return;
    }
    setDenied(ping?.status === 403);
    setUnreachable(!ping || (!ping.ok && ping.status !== 403));
    if (!ping?.ok) return;
    const [healthRes, connectorsRes] = await Promise.all([
      fetch(`${config.apiUrl}/health`).catch(() => null),
      call('/control/connectors/status').catch(() => null),
    ]);
    if (healthRes?.ok) setHealth((await healthRes.json()) as HealthInfo);
    if (!connectorsRes || connectorsRes.status === 404) setConnectors('absent');
    else if (!connectorsRes.ok) setConnectors('unreachable');
    else setConnectors((await connectorsRes.json()) as ConnectorStatus);
  }, [call, config.apiUrl]);

  useEffect(() => {
    if (getToken || sub) void reload();
  }, [reload, getToken, sub]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          munni<span className="dot">.</span> <span className="brand-sub">control</span>
        </div>
        <nav>
          {NAV.map(([id, label]) => (
            <button
              key={id}
              data-testid={`nav-${id}`}
              className={screen === id ? 'active' : ''}
              onClick={() => openScreen(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          {signOut && (
            <button className="btn" data-testid="control-signout" onClick={signOut}>
              Sign out
            </button>
          )}
          {!getToken && (
            <input
              data-testid="control-sub"
              value={sub}
              placeholder="test subject (X-User-Sub)"
              onChange={(e) => {
                setSub(e.target.value);
                localStorage.setItem('munni_control_sub', e.target.value);
              }}
            />
          )}
        </div>
      </aside>

      <main className="content">
        {denied && (
          <p className="denied">
            This account has no admin access yet — its sign-in carries no admin scope. An operator switches admin on for it in the setup wizard
            (the environment&apos;s Access tab); then sign out and in again — the role rides on the next token.
            {signOut && (
              <button className="btn" data-testid="control-denied-signout" style={{ marginLeft: 12 }} onClick={signOut}>
                Sign out
              </button>
            )}
          </p>
        )}
        {unreachable && <p className="denied">The control API did not answer — is the environment running (and this origin allowed)?</p>}
        {disconnected && <p className="denied">This browser was disconnected from the account — reload to register it again.</p>}
        {!blocked && screen === 'overview' && <OverviewScreen status={connectors} health={health} />}
        {!blocked && screen === 'connectors' && <ConnectorsScreen status={connectors} call={call} />}
      </main>
    </div>
  );
}

function Tile({ label, value, warn = false }: Readonly<{ label: string; value: string; warn?: boolean }>) {
  return (
    <div className={`tile ${warn ? 'tile-warn' : ''}`}>
      <div className="tile-value">{value}</div>
      <div className="tile-label">{label}</div>
    </div>
  );
}

/** the landing: the designated environment's parties at a glance, plus its health probe */
function OverviewScreen({ status, health }: Readonly<{ status: ConnectorsView; health: HealthInfo | null }>) {
  const caps = Object.entries(health?.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean');
  const live = status !== null && status !== 'absent' && status !== 'unreachable' ? status : null;
  return (
    <>
      <h1>Overview</h1>
      <div className="tiles" data-testid="control-tiles">
        <Tile label="Parties accepting work" value={live ? `${live.providers.filter((p) => p.acceptsWork).length} / ${live.providers.length}` : '—'} />
        <Tile label="Agents online" value={live ? `${live.agents.online} / ${live.agents.total}` : '—'} warn={!!live && live.agents.online === 0 && live.agents.total > 0} />
        <Tile
          label="Jobs in flight · awaiting input"
          value={live ? `${live.queue.queued + live.queue.running} · ${live.queue.awaitingInput}` : '—'}
          warn={!!live && live.queue.awaitingInput > 0}
        />
      </div>

      {health && (
        <section className="card">
          <h2>Environment health</h2>
          <p className="hint">The designated environment&apos;s API serves /control.</p>
          <div className="chips" data-testid="control-health">
            <span className="chip on">build {health.build ?? '—'}</span>
            {caps.map(([name, on]) => (
              <span key={name} className={`chip ${on ? 'on' : ''}`}>
                {name}
              </span>
            ))}
          </div>
        </section>
      )}
    </>
  );
}

const STATE_CHIP: Record<string, string> = { healthy: 'ok-chip', degraded: 'warn-chip', paused: 'warn-chip', retired: 'danger-chip' };

/** the designated environment's connector control plane, read-only: the
 * parties' states and budgets, the fleet's liveness, and an aggregator's
 * inventory of consents per environment. Pausing, resuming, revoking stay
 * in the environment's own admin portal, like every other write. */
function ConnectorsScreen({ status, call }: Readonly<{ status: ConnectorsView; call: (path: string) => Promise<Response> }>) {
  // null = closed; 'loading'; 'none' = the party keeps no inventory; else its consents
  const [inventory, setInventory] = useState<{ id: string; consents: RemoteConsent[] | 'loading' | 'none' } | null>(null);

  const openInventory = async (providerId: string) => {
    setInventory({ id: providerId, consents: 'loading' });
    const res = await call(`/control/connectors/providers/${encodeURIComponent(providerId)}/remote-consents`).catch(() => null);
    if (!res?.ok) {
      setInventory({ id: providerId, consents: 'none' });
      return;
    }
    setInventory({ id: providerId, consents: ((await res.json()) as { consents: RemoteConsent[] }).consents });
  };

  if (status === null || status === 'absent' || status === 'unreachable') {
    const note = {
      absent: 'The designated environment runs no connectors.',
      unreachable: 'The designated environment’s control plane did not answer.',
    };
    return (
      <>
        <h1>Connectors</h1>
        <section className="card" data-testid="control-connectors-note">
          <p className="hint">{status === null ? 'loading…' : note[status]}</p>
        </section>
      </>
    );
  }
  return (
    <>
      <h1>Connectors</h1>
      <p className="muted">
        The designated environment&apos;s control plane, read-only. Pause, resume, retire and revoke from that environment&apos;s own admin portal.
      </p>
      <div className="tiles" data-testid="control-connectors-tiles">
        <Tile label="Parties accepting work" value={`${status.providers.filter((p) => p.acceptsWork).length} / ${status.providers.length}`} />
        <Tile label="Agents online" value={`${status.agents.online} / ${status.agents.total}`} warn={status.agents.online === 0 && status.agents.total > 0} />
        <Tile label="Jobs in flight · awaiting input" value={`${status.queue.queued + status.queue.running} · ${status.queue.awaitingInput}`} warn={status.queue.awaitingInput > 0} />
      </div>
      <section className="card">
        <h2>Parties</h2>
        <p className="hint">
          control plane {status.service.version} · catalogue {status.service.manifestDigest.slice(0, 12)} · {status.service.kinds.join(', ')}. The
          budget is what a party last said about its own allowance (an aggregator&apos;s daily calls — one account serves every environment).
        </p>
        <table data-testid="control-connectors">
          <thead>
            <tr>
              <th>Party</th>
              <th>State</th>
              <th>Since</th>
              <th>Budget</th>
              <th>Reason</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {status.providers.map((p) => (
              <tr key={p.providerId} className={p.acceptsWork ? '' : 'stale'}>
                <td>{p.providerId}</td>
                <td>
                  <span className={`chip ${STATE_CHIP[p.state] ?? ''}`}>{p.state}</span>
                </td>
                <td>{when(p.since)}</td>
                <td className={quotaLow(p.quota) ? 'warn' : ''} data-testid={`control-quota-${p.providerId}`}>
                  {quotaLine(p.quota)}
                </td>
                <td>{p.reasonKey ?? '—'}</td>
                <td className="cell-actions">
                  <button data-testid={`control-inventory-${p.providerId}`} className="btn" onClick={() => void openInventory(p.providerId)}>
                    inventory
                  </button>
                </td>
              </tr>
            ))}
            {status.providers.length === 0 && (
              <tr>
                <td colSpan={6}>—</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {inventory && (
        <section className="card" data-testid={`control-inventory-panel-${inventory.id}`}>
          <div className="card-head">
            <h2>Inventory · {inventory.id} — all environments</h2>
            <button className="btn" data-testid="control-inventory-close" onClick={() => setInventory(null)}>
              close
            </button>
          </div>
          <p className="hint">
            Every consent on the party&apos;s account, grouped by the environment it was started from (its return origin). Read-only — revoke
            a leftover from an environment&apos;s own admin portal.
          </p>
          {inventory.consents === 'loading' && <p className="hint">loading…</p>}
          {inventory.consents === 'none' && (
            <p className="hint" data-testid="control-inventory-none">
              This party keeps no inventory (or the control plane did not answer).
            </p>
          )}
          {Array.isArray(inventory.consents) && <InventoryGroups consents={inventory.consents} />}
        </section>
      )}
    </>
  );
}

function InventoryGroups({ consents }: Readonly<{ consents: RemoteConsent[] }>) {
  const groups = groupByOrigin(consents);
  if (groups.length === 0) {
    return (
      <p className="hint" data-testid="control-inventory-empty">
        No consents on the party&apos;s account yet.
      </p>
    );
  }
  return (
    <>
      {groups.map(([origin, rows]) => (
        <section className="card" key={origin} data-testid={`control-group-${origin}`}>
          <h3>
            {origin} · {rows.length} consent{rows.length === 1 ? '' : 's'} · {rows.reduce((sum, c) => sum + c.accountCount, 0)} accounts
          </h3>
          <table>
            <thead>
              <tr>
                <th>Institution</th>
                <th>Status</th>
                <th>Accounts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id}>
                  <td>
                    <div className="cell-title">{c.institutionId ?? '—'}</div>
                    <div className="cell-sub">
                      {c.id.slice(0, 13)}… · {c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}
                    </div>
                  </td>
                  <td>{c.status}</td>
                  <td>{c.accountCount} acct</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </>
  );
}
