import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { ago, shortId, when } from '../../lib/format';
import type { AgentView, Enrollment, PrivateAgents } from '../../types';
import { AbsentCard } from '../dashboard/DashboardScreen';

export function agentHealth(agent: AgentView): { label: string; chip: string } {
  if (agent.revoked) return { label: 'revoked', chip: 'danger-chip' };
  if (agent.stale) return { label: 'stale catalogue', chip: 'warn-chip' };
  if (agent.online) return { label: 'online', chip: 'ok-chip' };
  return { label: 'offline', chip: 'warn-chip' };
}

const REQUEST_CHIP: Record<string, string> = { pending: 'warn-chip', approved: 'ok-chip', denied: 'danger-chip', released: '' };

/** who holds a slot: the person, nobody, or nobody yet (the previous person's sign-ins are still being wiped) */
export function slotHolder(slot: PrivateAgents['slots'][number]): { label: string; chip: string | null } {
  if (slot.agent.resetting) return { label: 'wiping…', chip: 'warn-chip' };
  if (slot.agent.bound) return { label: slot.who ?? slot.subject ?? 'somebody', chip: null };
  return { label: 'free', chip: null };
}

/** the fleet as the operator sees it: every agent whoever owns it, the private slots, and a door to enrol a browser for the lab */
export function AgentsScreen({ call, busy, act }: Readonly<ScreenProps>) {
  const [agents, setAgents] = useState<AgentView[] | null | 'unreachable' | 'loading'>('loading');
  // null = the relay answers no private-agent routes; the section is for an environment that has them
  const [privateAgents, setPrivateAgents] = useState<PrivateAgents | null>(null);
  const [name, setName] = useState('');
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    const [list, priv] = await Promise.all([getJson<{ agents: AgentView[] }>(call, '/lab/agents'), getJson<PrivateAgents>(call, '/lab/private-agents')]);
    setAgents(list === null || list === 'unreachable' ? list : list.agents);
    setPrivateAgents(priv && priv !== 'unreachable' ? priv : null);
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (agent: AgentView) => {
    // a revocation destroys the profiles that keep the user's logins alive — say so before it happens
    if (!globalThis.confirm(`Revoke ${agent.name}? Its ${agent.profiles.length} kept login(s) are destroyed; the owner signs in again through a fresh agent.`)) return;
    if (await act(() => call(`/lab/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE' }))) await load();
  };

  const decide = async (requestId: string, decision: 'approve' | 'deny') => {
    if (await act(() => call(`/lab/private-agents/requests/${encodeURIComponent(requestId)}/${decision}`, { method: 'POST' }))) await load();
  };

  const takeBack = async (slot: PrivateAgents['slots'][number]) => {
    if (!globalThis.confirm(`Take ${slot.agent.name} back from ${slot.who ?? slot.subject ?? 'its holder'}? Its ${slot.agent.profiles.length} kept login(s) are wiped before the next person gets it.`)) return;
    if (await act(() => call(`/lab/private-agents/${encodeURIComponent(slot.agent.id)}/release`, { method: 'POST' }))) await load();
  };

  const enrol = async () => {
    const res = await call('/lab/agents/enrollment', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }).catch(() => null);
    if (!res?.ok) {
      await act(async () => res ?? new Response(null, { status: 0 }));
      return;
    }
    setEnrollment((await res.json()) as Enrollment);
    setCopied(false);
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  if (agents === 'loading') {
    return (
      <>
        <h1>Agents</h1>
        <p className="hint">loading…</p>
      </>
    );
  }
  if (agents === null) {
    return (
      <>
        <h1>Agents</h1>
        <AbsentCard />
      </>
    );
  }
  if (agents === 'unreachable') {
    return (
      <>
        <h1>Agents</h1>
        <section className="card" data-testid="lab-status-unreachable">
          <p className="hint">The control plane did not answer.</p>
        </section>
      </>
    );
  }

  const online = agents.filter((a) => a.online && !a.revoked).length;
  const pooled = agents.filter((a) => a.class === 'pooled');
  const own = agents.filter((a) => a.class !== 'pooled');

  return (
    <>
      <h1>Agents</h1>
      <div className="tiles" data-testid="agents-tiles">
        <div className={`tile ${online === 0 && agents.length > 0 ? 'tile-danger' : ''}`}>
          <div className="tile-value">
            {online} / {agents.length}
          </div>
          <div className="tile-label">Online</div>
        </div>
        <div className="tile">
          <div className="tile-value">{pooled.length}</div>
          <div className="tile-label">Pooled (the fleet)</div>
        </div>
        <div className="tile">
          <div className="tile-value">{own.length}</div>
          <div className="tile-label">Own machines and hosted slots</div>
        </div>
      </div>

      <section className="card">
        <h2>Every agent</h2>
        <p className="hint">
          The fleet (pooled), the people&apos;s own machines (byo) and the hosted private slots, with the logins each keeps. Revoking an agent
          destroys the logins it keeps — its owner signs in again through a fresh one.
        </p>
        <table data-testid="agents-table">
          <thead>
            <tr>
              <th>Agent</th>
              <th>Class</th>
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
                    <div className="cell-sub">{shortId(a.id)}</div>
                  </td>
                  <td>
                    {a.class}
                    {a.hosted ? ' · hosted' : ''}
                  </td>
                  <td>
                    <span className={`chip ${health.chip}`} data-testid={`agent-health-${a.id}`}>
                      {health.label}
                    </span>
                  </td>
                  <td title={when(a.lastHeartbeatAt)}>{ago(a.lastHeartbeatAt)}</td>
                  <td>
                    <div className="chips">
                      {a.profiles.map((profile) => (
                        <span key={profile.id} className={`chip ${profile.healthy ? 'ok-chip' : 'warn-chip'}`} title={profile.lastOkAt ? `last ok ${when(profile.lastOkAt)}` : 'never ok'}>
                          {profile.provider}
                        </span>
                      ))}
                      {a.profiles.length === 0 && <span className="sub">—</span>}
                    </div>
                  </td>
                  <td className="cell-actions">
                    {!a.revoked && !a.hosted && (
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
                <td colSpan={6} className="empty">
                  No agent has dialled in yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {privateAgents && (
        <section className="card" data-testid="agents-private">
          <div className="card-head">
            <h2>Private slots</h2>
            <span className="sub" data-testid="agents-private-free">
              {privateAgents.free} of {privateAgents.total} free
            </span>
          </div>
          <p className="hint">
            munni&apos;s own browsers for one person each (#420): a user asks under Your own computer, you approve and the oldest free slot
            is theirs. Taking one back wipes the sign-ins it keeps before the next person gets it. How many slots exist is the
            environment&apos;s count in the setup wizard.
          </p>
          <table data-testid="agents-private-requests">
            <thead>
              <tr>
                <th>Request</th>
                <th>Who</th>
                <th>Since</th>
                <th>State</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {privateAgents.requests.map((r) => (
                <tr key={r.id} data-testid={`private-request-${r.id}`} className={r.state === 'pending' ? '' : 'stale'}>
                  <td className="mono">{shortId(r.id)}</td>
                  <td>{r.who ?? r.subject}</td>
                  <td>{when(r.createdAt)}</td>
                  <td>
                    <span className={`chip ${REQUEST_CHIP[r.state] ?? ''}`}>{r.state}</span>
                  </td>
                  <td className="cell-actions">
                    {r.state === 'pending' && (
                      <>
                        <button data-testid={`private-approve-${r.id}`} disabled={busy || privateAgents.free === 0} onClick={() => void decide(r.id, 'approve')}>
                          approve
                        </button>
                        <button data-testid={`private-deny-${r.id}`} className="btn danger" disabled={busy} onClick={() => void decide(r.id, 'deny')}>
                          deny
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {privateAgents.requests.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty">
                    No requests.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <table data-testid="agents-private-slots">
            <thead>
              <tr>
                <th>Slot</th>
                <th>Health</th>
                <th>Holder</th>
                <th>Since</th>
                <th>Logins kept</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {privateAgents.slots.map((s) => {
                const health = agentHealth(s.agent);
                const holder = slotHolder(s);
                return (
                  <tr key={s.agent.id} data-testid={`private-slot-${s.agent.id}`}>
                    <td>
                      <div className="cell-title">{s.agent.name}</div>
                      <div className="cell-sub">{shortId(s.agent.id)}</div>
                    </td>
                    <td>
                      <span className={`chip ${health.chip}`}>{health.label}</span>
                    </td>
                    <td>{holder.chip ? <span className={`chip ${holder.chip}`}>{holder.label}</span> : holder.label}</td>
                    <td>{when(s.agent.boundAt)}</td>
                    <td>{s.agent.profiles.length}</td>
                    <td className="cell-actions">
                      {s.agent.bound && (
                        <button data-testid={`private-release-${s.agent.id}`} className="btn danger" disabled={busy} onClick={() => void takeBack(s)}>
                          take back
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {privateAgents.slots.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    No private slots — set a count on the environment in the setup wizard.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      <section className="card" data-testid="agents-enrol">
        <h2>Enrol a browser for the lab</h2>
        <p className="hint">
          A household agent that serves the lab&apos;s own subject — the machine the test bench and the recorder run on when you pick
          it. Name it, copy the line into a terminal where Docker runs; it dials in within a minute and appears above.
        </p>
        <div className="row">
          <input data-testid="agents-enrol-name" placeholder="name the machine" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
          <button className="btn" data-testid="agents-enrol-submit" disabled={busy || name.trim().length === 0} onClick={() => void enrol()}>
            Mint a code
          </button>
        </div>
        {enrollment && (
          <div data-testid="agents-enrollment">
            <pre className="code">{enrollment.composeCommand ?? enrollment.code}</pre>
            <div className="row">
              <button data-testid="agents-enrol-copy" onClick={() => void copy(enrollment.composeCommand ?? enrollment.code)}>
                {copied ? 'copied' : 'copy'}
              </button>
              <span className="sub">
                code {enrollment.code} — single-use, valid until {when(enrollment.expiresAt)}
                {enrollment.controlPlaneUrl ? '' : ' · this environment publishes no agent address, so the code has nowhere to dial'}
              </span>
            </div>
          </div>
        )}
      </section>
    </>
  );
}
