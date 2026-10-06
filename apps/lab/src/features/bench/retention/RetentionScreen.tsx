import { useCallback, useEffect, useState } from 'react';
import { getJson } from '../../../app/api';
import type { ScreenProps } from '../../../app/LabApp';
import { hrefOf, navigate, useRouteQuery } from '../../../app/router';
import { ago } from '../../../lib/format';
import type { AgentView, Catalogue, RetentionRun } from '../../../types';
import { AbsentCard } from '../../dashboard/DashboardScreen';
import { runChip, runSummary } from './retentionFacts';

/**
 * The retention bench (#441 L4): pick an agent and a party, and the lab
 * signs in on that agent with the recording on, fetches, reads what the
 * agent kept, fetches again expecting no sign-in, and — for a hosted
 * slot — releases it and watches the wipe. Every run is a report with its
 * steps' verdicts, kept on the relay, listed here newest first.
 */
export function RetentionScreen({ call, busy }: Readonly<ScreenProps>) {
  const query = useRouteQuery();
  const [runs, setRuns] = useState<RetentionRun[] | null | 'unreachable' | 'loading'>('loading');
  const [agents, setAgents] = useState<AgentView[]>([]);
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [agentId, setAgentId] = useState(query.get('agent') ?? '');
  const [provider, setProvider] = useState('');
  const [resource, setResource] = useState('');
  const [label, setLabel] = useState('');
  const [release, setRelease] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [r, a, c] = await Promise.all([getJson<RetentionRun[]>(call, '/lab/bench/retention/runs'), getJson<{ agents: AgentView[] }>(call, '/lab/agents'), getJson<Catalogue>(call, '/lab/providers')]);
    setRuns(r);
    setAgents(a && a !== 'unreachable' ? a.agents.filter((x) => !x.revoked) : []);
    setCatalogue(c && c !== 'unreachable' ? c : null);
  }, [call]);
  useEffect(() => {
    void load();
  }, [load]);

  if (runs === 'loading') return <p className="hint">loading…</p>;
  if (runs === null) {
    return (
      <>
        <h1>Retention bench</h1>
        <AbsentCard />
      </>
    );
  }
  if (runs === 'unreachable') {
    return (
      <>
        <h1>Retention bench</h1>
        <section className="card" data-testid="lab-status-unreachable">
          <p className="hint">The control plane did not answer.</p>
        </section>
      </>
    );
  }

  const parties = [...(catalogue?.providers ?? [])].filter((p) => (p.resources ?? []).length > 0).sort((a, b) => a.name.localeCompare(b.name));
  const party = parties.find((p) => p.id === provider) ?? null;
  const resources = party?.resources ?? [];
  const chosenResource = resources.find((r) => r.id === resource)?.id ?? resources[0]?.id ?? '';
  const agent = agents.find((a) => a.id === agentId);
  const nameOf = (id: string | null | undefined) => (id ? (parties.find((p) => p.id === id)?.name ?? id) : '—');

  const start = async () => {
    if (!party || !chosenResource) return;
    setError(null);
    const res = await call('/lab/bench/retention/runs', {
      method: 'POST',
      body: JSON.stringify({ provider: party.id, resource: chosenResource, agentId: agentId || undefined, agentName: agent?.name, label: label || undefined }),
    }).catch(() => null);
    if (!res?.ok) {
      setError(res ? `HTTP ${res.status}` : 'network');
      return;
    }
    const run = (await res.json()) as RetentionRun;
    navigate(`bench/retention/${encodeURIComponent(run.id)}${release && agent?.hosted ? '?release=1' : ''}`);
  };

  return (
    <>
      <p>
        <a href={hrefOf('bench')}>← Bench</a>
      </p>
      <h1>Retention bench</h1>
      <p className="hint">
        Does an agent keep a login, and does the next fetch use it? Pick the agent and the party: the lab signs in on that agent with the recording
        on, fetches, reads what the agent kept, fetches again expecting no sign-in, and — for a hosted slot, when asked — releases it and watches
        the wipe. Each step&apos;s verdict is kept with the run.
      </p>

      <section className="card" data-testid="retention-form">
        <h2>New run</h2>
        <div className="facts">
          <label className="fact">
            <span className="fact-label">agent</span>
            <select data-testid="retention-agent" value={agentId} onChange={(e) => setAgentId(e.target.value)}>
              <option value="">whatever the queue decides</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.class}
                  {a.hosted ? ' · hosted' : ''} · {a.online ? 'online' : 'offline'}
                </option>
              ))}
            </select>
          </label>
          <label className="fact">
            <span className="fact-label">party</span>
            <select
              data-testid="retention-party"
              value={provider}
              onChange={(e) => {
                setProvider(e.target.value);
                setResource('');
              }}
            >
              <option value="">pick a party…</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id}){p.runtime === 'browser_persistent' ? ' · keeps a browser' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="fact">
            <span className="fact-label">resource</span>
            <select data-testid="retention-resource" value={chosenResource} disabled={!party} onChange={(e) => setResource(e.target.value)}>
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} → {r.returns}
                </option>
              ))}
            </select>
          </label>
          <label className="fact">
            <span className="fact-label">label</span>
            <input data-testid="retention-label" value={label} placeholder="how the history names it" onChange={(e) => setLabel(e.target.value)} />
          </label>
          {agent?.hosted && (
            <div className="fact">
              <span className="fact-label">afterwards</span>
              <button type="button" role="switch" aria-checked={release} className={`btn quiet${release ? ' on' : ''}`} data-testid="retention-release" onClick={() => setRelease((v) => !v)}>
                {release ? 'release the slot and watch the wipe' : 'leave the slot as it is'}
              </button>
            </div>
          )}
        </div>
        {error && (
          <p className="error" data-testid="retention-error">
            {error}
          </p>
        )}
        <div className="row">
          <button className="btn" data-testid="retention-start" disabled={busy || !party || !chosenResource} onClick={() => void start()}>
            start the run
          </button>
        </div>
      </section>

      <section className="card">
        <h2>History</h2>
        <table data-testid="retention-runs">
          <thead>
            <tr>
              <th>When</th>
              <th>Agent</th>
              <th>Party · resource</th>
              <th>Verdict</th>
              <th>Steps</th>
              <th>Label</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} data-testid={`retention-run-${r.id}`} className="clickable" onClick={() => navigate(`bench/retention/${encodeURIComponent(r.id)}`)}>
                <td title={r.createdAt}>{ago(r.createdAt)}</td>
                <td>{r.agentName ?? r.agentId ?? 'the queue'}</td>
                <td>
                  {nameOf(r.provider)} · {r.resource}
                </td>
                <td>
                  <span className={`chip ${runChip(r.state)}`} data-testid={`retention-state-${r.id}`}>
                    {r.state}
                  </span>
                </td>
                <td>{runSummary(r)}</td>
                <td>{r.label ?? '—'}</td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={6} className="empty">
                  No runs yet — pick an agent and a party above.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
