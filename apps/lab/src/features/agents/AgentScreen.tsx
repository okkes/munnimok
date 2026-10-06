import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf, navigate } from '../../app/router';
import { ago, when } from '../../lib/format';
import type { AgentView, JobList, PrivateAgents, RetentionRun } from '../../types';
import { runChip, runSummary } from '../bench/retention/retentionFacts';
import { outcomeLine, stateChip } from '../jobs/jobFacts';
import { agentHealth } from './AgentsScreen';

/** the agent's own claims, in words */
export function capabilityLines(agent: AgentView): { label: string; value: string }[] {
  const c = agent.capabilities;
  if (!c) return [{ label: 'Claims', value: 'none recorded' }];
  return [
    { label: 'Serves', value: c.providers && c.providers.length > 0 ? c.providers.join(', ') : 'every party this connector has' },
    { label: 'Runtimes', value: c.runtimes && c.runtimes.length > 0 ? c.runtimes.join(', ') : 'every runtime' },
    { label: 'Egress', value: c.egress ? `${c.egress.kind ?? 'any'} · ${c.egress.country ?? '—'}` : 'unclaimed' },
    { label: 'Concurrency', value: String(c.maxConcurrency ?? 1) },
  ];
}

/**
 * One agent in full (#441 L4): what it claims, the logins it keeps, the
 * runs it took, the retention runs made on it, and the doors — revoke,
 * take a hosted slot back, run the retention bench on it.
 */
export function AgentScreen({ id, call, busy, act }: Readonly<{ id: string } & ScreenProps>) {
  const [agent, setAgent] = useState<AgentView | null | 'unreachable' | 'loading'>('loading');
  const [holder, setHolder] = useState<string | null>(null);
  const [jobs, setJobs] = useState<JobList | null>(null);
  const [runs, setRuns] = useState<RetentionRun[]>([]);

  const load = useCallback(async () => {
    const [list, priv, history, retention] = await Promise.all([
      getJson<{ agents: AgentView[] }>(call, '/lab/agents'),
      getJson<PrivateAgents>(call, '/lab/private-agents'),
      getJson<JobList>(call, `/lab/jobs?agent=${encodeURIComponent(id)}&limit=50`),
      getJson<RetentionRun[]>(call, '/lab/bench/retention/runs'),
    ]);
    if (list === null || list === 'unreachable') {
      setAgent(list);
      return;
    }
    setAgent(list.agents.find((a) => a.id === id) ?? null);
    const slot = priv && priv !== 'unreachable' ? priv.slots.find((s) => s.agent.id === id) : undefined;
    setHolder(slot ? (slot.who ?? slot.subject ?? null) : null);
    setJobs(history && history !== 'unreachable' ? history : null);
    setRuns(retention && retention !== 'unreachable' ? retention.filter((r) => r.agentId === id) : []);
  }, [call, id]);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (a: AgentView) => {
    if (!globalThis.confirm(`Revoke ${a.name}? Its ${a.profiles.length} kept login(s) are destroyed; the owner signs in again through a fresh agent.`)) return;
    if (await act(() => call(`/lab/agents/${encodeURIComponent(a.id)}`, { method: 'DELETE' }))) await load();
  };

  const takeBack = async (a: AgentView) => {
    if (!globalThis.confirm(`Take ${a.name} back from ${holder ?? 'its holder'}? Its ${a.profiles.length} kept login(s) are wiped before the next person gets it.`)) return;
    if (await act(() => call(`/lab/private-agents/${encodeURIComponent(a.id)}/release`, { method: 'POST' }))) await load();
  };

  if (agent === 'loading') return <p className="hint">loading…</p>;
  if (agent === null || agent === 'unreachable') {
    return (
      <>
        <p>
          <a href={hrefOf('agents')}>← Agents</a>
        </p>
        <section className="card" data-testid="agent-missing">
          <p className="hint">{agent === null ? `No agent named ${id} on this control plane.` : 'The control plane did not answer.'}</p>
        </section>
      </>
    );
  }

  const health = agentHealth(agent);
  return (
    <>
      <p>
        <a href={hrefOf('agents')}>← Agents</a>
      </p>
      <div className="head-row">
        <h1 data-testid="agent-title">{agent.name}</h1>
        <span className={`chip ${health.chip}`} data-testid="agent-health">
          {health.label}
        </span>
        <span className="sub mono">{agent.id}</span>
        <span className="spacer" />
        <button className="btn" data-testid="agent-bench" onClick={() => navigate(`bench/retention?agent=${encodeURIComponent(agent.id)}`)}>
          retention bench on this agent
        </button>
        {!agent.revoked && !agent.hosted && (
          <button className="btn danger" data-testid="agent-revoke" disabled={busy} onClick={() => void revoke(agent)}>
            revoke
          </button>
        )}
        {agent.hosted && agent.bound && (
          <button className="btn danger" data-testid="agent-release" disabled={busy} onClick={() => void takeBack(agent)}>
            take the slot back
          </button>
        )}
      </div>

      <section className="card" data-testid="agent-facts">
        <h2>The machine</h2>
        <div className="facts">
          <Fact label="Class" value={`${agent.class}${agent.hosted ? ' · hosted slot' : ''}`} />
          <Fact label="Last heartbeat" value={`${ago(agent.lastHeartbeatAt)} · ${when(agent.lastHeartbeatAt)}`} />
          <Fact label="Online" value={agent.online ? 'yes' : 'no'} />
          <Fact label="Catalogue" value={agent.stale ? 'stale — rebuild the image' : 'matches the control plane'} />
          <Fact label="Revoked" value={agent.revoked ? 'yes' : 'no'} />
          {agent.hosted && <Fact label="Holder" value={agent.bound ? `${holder ?? 'somebody'} since ${when(agent.boundAt)}` : agent.resetting ? 'wiping…' : 'free'} />}
          {capabilityLines(agent).map((line) => (
            <Fact key={line.label} label={line.label} value={line.value} />
          ))}
        </div>
      </section>

      <section className="card" data-testid="agent-profiles">
        <h2>Logins kept</h2>
        {agent.profiles.length === 0 ? (
          <p className="hint">None — every run on this machine signs in afresh, or it keeps its sessions in bundles.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Party</th>
                <th>Profile</th>
                <th>Health</th>
                <th>Last ok</th>
              </tr>
            </thead>
            <tbody>
              {agent.profiles.map((p) => (
                <tr key={p.id} data-testid={`agent-profile-${p.id}`}>
                  <td>
                    <a href={hrefOf(`providers/${encodeURIComponent(p.provider)}`)}>{p.provider}</a>
                  </td>
                  <td className="mono">{p.id}</td>
                  <td>
                    <span className={`chip ${p.healthy ? 'ok-chip' : 'warn-chip'}`}>{p.healthy ? 'healthy' : 'unhealthy'}</span>
                  </td>
                  <td>{p.lastOkAt ? ago(p.lastOkAt) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card" data-testid="agent-jobs">
        <h2>Runs it took</h2>
        {!jobs || jobs.jobs.length === 0 ? (
          <p className="hint">None in the history.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Party</th>
                <th>Run</th>
                <th>State</th>
                <th>Outcome</th>
              </tr>
            </thead>
            <tbody>
              {jobs.jobs.map((job) => (
                <tr key={job.jobId} data-testid={`agent-job-${job.jobId}`} className="clickable" onClick={() => navigate(`jobs/${encodeURIComponent(job.jobId)}`)}>
                  <td>{ago(job.createdAt)}</td>
                  <td>{job.providerId}</td>
                  <td>
                    {job.kind}
                    {job.resource ? ` · ${job.resource}` : ''}
                  </td>
                  <td>
                    <span className={`chip ${stateChip(job.state)}`}>{job.state}</span>
                  </td>
                  <td>{outcomeLine(job)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {jobs?.truncated && <p className="hint">The list was cut at fifty — the Jobs screen narrows further.</p>}
      </section>

      <section className="card" data-testid="agent-retention">
        <h2>Retention runs on this agent</h2>
        {runs.length === 0 ? (
          <p className="hint">None yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Party · resource</th>
                <th>Verdict</th>
                <th>Steps</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} data-testid={`agent-retention-${r.id}`} className="clickable" onClick={() => navigate(`bench/retention/${encodeURIComponent(r.id)}`)}>
                  <td>{ago(r.createdAt)}</td>
                  <td>
                    {r.provider} · {r.resource}
                  </td>
                  <td>
                    <span className={`chip ${runChip(r.state)}`}>{r.state}</span>
                  </td>
                  <td>{runSummary(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: React.ReactNode }>) {
  return (
    <div className="fact">
      <span className="fact-label">{label}</span>
      <span className="fact-value">{value}</span>
    </div>
  );
}
