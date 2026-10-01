import { useCallback, useEffect, useState } from 'react';

/**
 * The connector platform as the operator sees it (#367 M6, plan §9): the
 * control plane's status per party with the kill switch, every user's
 * household agents, the canaries. Talks to /admin/connectors/* — the relay
 * with the admin scope — and renders the connector's own words
 * (docs/connectors/relay.md, "Operator").
 */
export interface ConnectorProviderStatus {
  providerId: string;
  state: string;
  since: string;
  reasonKey?: string | null;
  acceptsWork: boolean;
  /** what the party last said about its budget (§15: an aggregator's daily call allowance) */
  quota?: { limit?: number | null; remaining?: number | null; resetAt?: string | null; seenAt?: string | null } | null;
}
/** one consent on an aggregator's account as the party lists it (§15.6): every environment's, attributed by its return origin */
export interface ConnectorRemoteConsent {
  id: string;
  status: string;
  createdAt?: string | null;
  reference?: string | null;
  institutionId?: string | null;
  origin?: string | null;
  accountCount: number;
}
export interface ConnectorStatus {
  service: { kinds: string[]; version: string; manifestDigest: string };
  providers: ConnectorProviderStatus[];
  agents: { total: number; online: number; revoked: number };
  queue: { queued: number; running: number; awaitingInput: number };
  relay?: { openStreams: number };
}
export interface ConnectorAgent {
  id: string;
  name: string;
  class: string;
  revoked: boolean;
  lastHeartbeatAt?: string | null;
  online: boolean;
  stale: boolean;
  profiles: { id: string; provider: string; healthy: boolean; lastOkAt?: string | null }[];
}
export interface ConnectorCanary {
  providerId: string;
  resource: string;
  intervalMinutes: number;
  lastRunAt?: string | null;
  lastJobId?: string | null;
  intact?: boolean | null;
  verdict?: string | null;
}

type Call = (path: string, init?: RequestInit) => Promise<Response>;

/** the party's state as a chip: the connector's word, coloured by what it means for users */
const STATE_CHIP: Record<string, string> = { healthy: 'ok-chip', degraded: 'warn-chip', paused: 'warn-chip', retired: 'danger-chip' };

const when = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString() : '—');

/** the party's budget as one line: remaining of limit, when it resets — or nothing said yet */
export function quotaLine(quota: ConnectorProviderStatus['quota']): string {
  if (!quota || (quota.limit == null && quota.remaining == null)) return '—';
  const left = `${quota.remaining ?? '?'} / ${quota.limit ?? '?'}`;
  return quota.resetAt ? `${left} · resets ${when(quota.resetAt)}` : left;
}

/** a budget nearly spent wears a warning: a fifth left, or less */
const quotaLow = (quota: ConnectorProviderStatus['quota']): boolean =>
  quota?.remaining != null && quota.limit != null && quota.limit > 0 && quota.remaining <= quota.limit / 5;

function agentHealth(agent: ConnectorAgent): { label: string; chip: string } {
  if (agent.revoked) return { label: 'revoked', chip: 'danger-chip' };
  if (agent.stale) return { label: 'stale catalogue', chip: 'warn-chip' };
  if (agent.online) return { label: 'online', chip: 'ok-chip' };
  return { label: 'offline', chip: 'warn-chip' };
}

export function ConnectorsScreen({
  call,
  busy,
  act,
}: Readonly<{
  call: Call;
  busy: boolean;
  /** the console's action runner: busy, the error strip, the reload */
  act: (fn: () => Promise<Response>) => Promise<void>;
}>) {
  // null = loading; 'absent' = this environment runs no connectors (404); 'unreachable' = the control plane did not answer
  const [status, setStatus] = useState<ConnectorStatus | 'absent' | 'unreachable' | null>(null);
  const [agents, setAgents] = useState<ConnectorAgent[]>([]);
  const [canaries, setCanaries] = useState<ConnectorCanary[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [retire, setRetire] = useState<{ id: string; typed: string } | null>(null);
  // the inventory of one aggregator (§15.6): null = closed; 'loading'; 'none' = the party keeps no inventory; else the consents
  const [inventory, setInventory] = useState<{ id: string; consents: ConnectorRemoteConsent[] | 'loading' | 'none' } | null>(null);

  const load = useCallback(async () => {
    const res = await call('/admin/connectors/status').catch(() => null);
    if (!res || res.status === 404) {
      setStatus('absent');
      return;
    }
    if (!res.ok) {
      setStatus('unreachable');
      return;
    }
    setStatus((await res.json()) as ConnectorStatus);
    const [agentsRes, canariesRes] = await Promise.all([
      call('/admin/connectors/agents').catch(() => null),
      call('/admin/connectors/canaries').catch(() => null),
    ]);
    if (agentsRes?.ok) setAgents(((await agentsRes.json()) as { agents: ConnectorAgent[] }).agents);
    if (canariesRes?.ok) setCanaries(((await canariesRes.json()) as { canaries: ConnectorCanary[] }).canaries);
  }, [call]);

  useEffect(() => {
    void load();
  }, [load]);

  /** the kill switch: the state, and the reason key the app renders for users when it has copy for it */
  const setState = async (providerId: string, state: string) => {
    const reasonKey = reasons[providerId]?.trim() || null;
    await act(() =>
      call(`/admin/connectors/providers/${encodeURIComponent(providerId)}/status`, {
        method: 'POST',
        body: JSON.stringify({ state, reasonKey }),
      }),
    );
    setRetire(null);
    await load();
  };

  const revoke = async (agent: ConnectorAgent) => {
    // a revocation destroys the profiles that keep the user's logins alive — say so before it happens
    if (!window.confirm(`Revoke ${agent.name}? Its ${agent.profiles.length} kept login(s) are destroyed; the user signs in again through a fresh agent.`)) return;
    await act(() => call(`/admin/connectors/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }));
    await load();
  };

  /** the aggregator's own list of consents — every environment's, so leftovers of removed environments can go */
  const openInventory = async (providerId: string) => {
    setInventory({ id: providerId, consents: 'loading' });
    const res = await call(`/admin/connectors/providers/${encodeURIComponent(providerId)}/remote-consents`).catch(() => null);
    if (!res?.ok) {
      setInventory({ id: providerId, consents: 'none' });
      return;
    }
    setInventory({ id: providerId, consents: ((await res.json()) as { consents: ConnectorRemoteConsent[] }).consents });
  };

  const revokeConsent = async (providerId: string, consent: ConnectorRemoteConsent) => {
    // revoking a consent ends someone's bank access — possibly another environment's; the origin says whose
    const whose = consent.origin ? `started from ${consent.origin}` : 'of unknown origin';
    if (!window.confirm(`Revoke consent ${consent.id.slice(0, 13)}… (${whose}) at ${providerId}? Its accounts stop fetching wherever it is used.`)) return;
    await act(() => call(`/admin/connectors/providers/${encodeURIComponent(providerId)}/remote-consents/${encodeURIComponent(consent.id)}`, { method: 'DELETE' }));
    await openInventory(providerId);
  };

  if (status === null) {
    return (
      <>
        <h1>Connectors</h1>
        <p className="hint">loading…</p>
      </>
    );
  }
  if (status === 'absent' || status === 'unreachable') {
    return (
      <>
        <h1>Connectors</h1>
        <section className="card" data-testid="connectors-absent">
          <p className="hint">
            {status === 'absent'
              ? 'This environment runs no connectors — the relay is not configured (the environment’s Connectors tick in the setup wizard renders the control plane and the api’s Connectors:* settings).'
              : 'The control plane did not answer. The relay is configured, but its control plane is down or unreachable from the api.'}
          </p>
        </section>
      </>
    );
  }

  return (
    <>
      <h1>Connectors</h1>
      <div className="tiles" data-testid="connectors-tiles">
        <div className="tile">
          <div className="tile-value">{status.providers.filter((p) => p.acceptsWork).length} / {status.providers.length}</div>
          <div className="tile-label">Parties accepting work</div>
        </div>
        <div className={`tile ${status.agents.online === 0 && status.agents.total > 0 ? 'tile-warn' : ''}`}>
          <div className="tile-value">{status.agents.online} / {status.agents.total}</div>
          <div className="tile-label">Agents online</div>
        </div>
        <div className={`tile ${status.queue.awaitingInput > 0 ? 'tile-warn' : ''}`}>
          <div className="tile-value">{status.queue.queued + status.queue.running} · {status.queue.awaitingInput}</div>
          <div className="tile-label">Jobs in flight · awaiting input</div>
        </div>
        <div className="tile">
          <div className="tile-value">{status.relay?.openStreams ?? 0}</div>
          <div className="tile-label">Open event streams</div>
        </div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Parties</h2>
          <span className="sub">
            control plane {status.service.version} · catalogue {status.service.manifestDigest.slice(0, 12)} · {status.service.kinds.join(', ')}
          </span>
        </div>
        <p className="hint">
          The kill switch: pause a party the moment it misbehaves (users see it paused, nothing is fetched), resume it when it is fine
          again, retire it for good — retiring expires every live session. A reason key is optional; the app shows its copy to users
          when it carries one (for example connect.paused.maintenance). The budget is what a party last said about its own allowance
          (an aggregator&apos;s daily calls); an aggregator also lists every consent on its account under Inventory.
        </p>
        <table data-testid="connectors-providers">
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
              <tr key={p.providerId} data-testid={`connector-${p.providerId}`} className={p.acceptsWork ? '' : 'stale'}>
                <td>
                  <div className="cell-title">{p.providerId}</div>
                </td>
                <td>
                  <span className={`chip ${STATE_CHIP[p.state] ?? ''}`} data-testid={`connector-state-${p.providerId}`}>
                    {p.state}
                  </span>
                </td>
                <td>{when(p.since)}</td>
                <td className={quotaLow(p.quota) ? 'warn' : ''} data-testid={`connector-quota-${p.providerId}`}>
                  {quotaLine(p.quota)}
                </td>
                <td>
                  <div className="sub">{p.reasonKey ?? '—'}</div>
                  {p.state !== 'retired' && (
                    <input
                      data-testid={`connector-reason-${p.providerId}`}
                      placeholder="reason key (optional)"
                      value={reasons[p.providerId] ?? ''}
                      maxLength={120}
                      onChange={(e) => setReasons((prev) => ({ ...prev, [p.providerId]: e.target.value }))}
                    />
                  )}
                </td>
                <td className="cell-actions">
                  <button data-testid={`connector-inventory-${p.providerId}`} className="btn" disabled={busy} onClick={() => void openInventory(p.providerId)}>
                    inventory
                  </button>
                  {p.state !== 'retired' && p.state !== 'paused' && (
                    <button data-testid={`connector-pause-${p.providerId}`} className="btn" disabled={busy} onClick={() => void setState(p.providerId, 'paused')}>
                      pause
                    </button>
                  )}
                  {p.state === 'paused' && (
                    <button data-testid={`connector-resume-${p.providerId}`} className="btn" disabled={busy} onClick={() => void setState(p.providerId, 'healthy')}>
                      resume
                    </button>
                  )}
                  {p.state === 'degraded' && (
                    <button data-testid={`connector-heal-${p.providerId}`} className="btn" disabled={busy} onClick={() => void setState(p.providerId, 'healthy')}>
                      mark healthy
                    </button>
                  )}
                  {p.state !== 'retired' && retire?.id !== p.providerId && (
                    <button data-testid={`connector-retire-${p.providerId}`} className="btn danger" disabled={busy} onClick={() => setRetire({ id: p.providerId, typed: '' })}>
                      retire…
                    </button>
                  )}
                  {retire?.id === p.providerId && (
                    <span className="confirm-delete">
                      <input
                        data-testid="connector-retire-typed"
                        placeholder={'type ' + p.providerId}
                        value={retire.typed}
                        onChange={(e) => setRetire({ id: p.providerId, typed: e.target.value })}
                      />
                      <button data-testid="connector-retire-confirm" className="btn danger" disabled={busy || retire.typed !== p.providerId} onClick={() => void setState(p.providerId, 'retired')}>
                        retire
                      </button>
                    </span>
                  )}
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
        <section className="card" data-testid={`connector-inventory-panel-${inventory.id}`}>
          <div className="card-head">
            <h2>Inventory · {inventory.id}</h2>
            <button className="btn" data-testid="connector-inventory-close" onClick={() => setInventory(null)}>
              close
            </button>
          </div>
          <p className="hint">
            Every consent on the party&apos;s account, attributed by the environment it was started from (its return origin). Revoking one
            ends that consent&apos;s bank access wherever it is used — meant for leftovers of removed environments.
          </p>
          {inventory.consents === 'loading' && <p className="hint">loading…</p>}
          {inventory.consents === 'none' && (
            <p className="hint" data-testid="connector-inventory-none">
              This party keeps no inventory (or the control plane did not answer).
            </p>
          )}
          {Array.isArray(inventory.consents) && (
            <table data-testid="connector-inventory">
              <thead>
                <tr>
                  <th>Consent</th>
                  <th>Institution</th>
                  <th>Status</th>
                  <th>Accounts</th>
                  <th>Environment</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {inventory.consents.map((c) => (
                  <tr key={c.id} data-testid={`remote-consent-${c.id}`}>
                    <td>
                      <div className="cell-title">{c.id.slice(0, 13)}…</div>
                      <div className="cell-sub">{c.createdAt ? new Date(c.createdAt).toLocaleDateString() : '—'}</div>
                    </td>
                    <td>{c.institutionId ?? '—'}</td>
                    <td>{c.status}</td>
                    <td>{c.accountCount} acct</td>
                    <td>{c.origin ?? 'unattributed'}</td>
                    <td className="cell-actions">
                      <button data-testid={`remote-consent-revoke-${c.id}`} className="btn danger" disabled={busy} onClick={() => void revokeConsent(inventory.id, c)}>
                        revoke
                      </button>
                    </td>
                  </tr>
                ))}
                {inventory.consents.length === 0 && (
                  <tr>
                    <td colSpan={6}>No consents on the party&apos;s account.</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </section>
      )}

      <section className="card">
        <h2>Household agents</h2>
        <p className="hint">
          Every user&apos;s own machine that dialled in. Revoking an agent destroys the logins it keeps — the user signs in again through a
          fresh one.
        </p>
        <table data-testid="connectors-agents">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Health</th>
              <th>Last heartbeat</th>
              <th>Logins kept</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const health = agentHealth(a);
              return (
                <tr key={a.id} data-testid={`agent-${a.id}`} className={a.online && !a.revoked ? '' : 'stale'}>
                  <td>
                    <div className="cell-title">{a.name}</div>
                    <div className="cell-sub">
                      {a.class} · {a.id.slice(0, 12)}…
                    </div>
                  </td>
                  <td>
                    <span className={`chip ${health.chip}`}>{health.label}</span>
                  </td>
                  <td>{when(a.lastHeartbeatAt)}</td>
                  <td>
                    <div className="chips">
                      {a.profiles.map((profile) => (
                        <span key={profile.id} className={`chip ${profile.healthy ? 'ok-chip' : 'warn-chip'}`}>
                          {profile.provider}
                        </span>
                      ))}
                      {a.profiles.length === 0 && <span className="sub">—</span>}
                    </div>
                  </td>
                  <td className="cell-actions">
                    {!a.revoked && (
                      <button data-testid={`agent-revoke-${a.id}`} className="btn danger" disabled={busy} onClick={() => void revoke(a)}>
                        revoke
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {agents.length === 0 && (
              <tr>
                <td colSpan={5}>No household agents enrolled.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <h2>Canaries</h2>
        <p className="hint">The operator&apos;s own connections that prove a party still works, fetched on their interval.</p>
        <table data-testid="connectors-canaries">
          <thead>
            <tr>
              <th>Party</th>
              <th>Resource</th>
              <th>Every</th>
              <th>Last run</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {canaries.map((c) => (
              <tr key={`${c.providerId}:${c.resource}`} className={c.intact === false ? 'stale' : ''}>
                <td>{c.providerId}</td>
                <td>{c.resource}</td>
                <td>{c.intervalMinutes} min</td>
                <td>{when(c.lastRunAt)}</td>
                <td>
                  {c.intact === null || c.intact === undefined ? (
                    <span className="sub">not run yet</span>
                  ) : (
                    <span className={`chip ${c.intact ? 'ok-chip' : 'danger-chip'}`}>{c.intact ? 'intact' : (c.verdict ?? 'broken')}</span>
                  )}
                </td>
              </tr>
            ))}
            {canaries.length === 0 && (
              <tr>
                <td colSpan={5}>No canaries configured.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
