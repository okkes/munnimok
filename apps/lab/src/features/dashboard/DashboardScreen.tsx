import { useEffect, useState } from 'react';
import { getJson } from '../../app/api';
import type { ScreenProps } from '../../app/LabApp';
import { hrefOf } from '../../app/router';
import { when } from '../../lib/format';
import type { ConnectorStatus, HealthInfo, HealthReport } from '../../types';
import { StateChip } from '../providers/StateChip';

const day = (report: HealthReport) => report.providers.map((p) => p.windows['24h']).filter((w) => w !== undefined);
export const failedToday = (report: HealthReport): number => day(report).reduce((n, w) => n + w.failed + w.expired, 0);
export const peopleToday = (report: HealthReport): number => day(report).reduce((n, w) => n + w.peopleAffected, 0);
export const reportsToRead = (report: HealthReport): number => report.providers.reduce((n, p) => n + p.reports, 0);

/** the environment's connector platform at a glance: the fleet, the queue, the parties' health */
export function DashboardScreen({ call }: Readonly<ScreenProps>) {
  // null = this environment runs no connectors (404); 'unreachable' = the control plane did not answer
  const [status, setStatus] = useState<ConnectorStatus | null | 'unreachable' | 'loading'>('loading');
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [report, setReport] = useState<HealthReport | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      const [s, h, r] = await Promise.all([
        getJson<ConnectorStatus>(call, '/lab/status'),
        getJson<HealthInfo>(call, '/health'),
        getJson<HealthReport>(call, '/lab/health'),
      ]);
      if (!live) return;
      setStatus(s);
      setHealth(h && h !== 'unreachable' ? h : null);
      setReport(r && r !== 'unreachable' ? r : null);
    })();
    return () => {
      live = false;
    };
  }, [call]);

  const caps = Object.entries(health?.capabilities ?? {}).filter(([, v]) => typeof v === 'boolean');

  return (
    <>
      <h1>Dashboard</h1>
      {status === 'loading' && <p className="hint">loading…</p>}
      {status === null && <AbsentCard />}
      {status === 'unreachable' && (
        <section className="card" data-testid="lab-status-unreachable">
          <p className="hint">The control plane did not answer. The relay is configured, but its control plane is down or unreachable from the api.</p>
        </section>
      )}
      {status !== 'loading' && status !== null && status !== 'unreachable' && (
        <>
          <div className="tiles" data-testid="dashboard-tiles">
            <div className={`tile ${status.providers.some((p) => !p.acceptsWork) ? 'tile-warn' : ''}`}>
              <div className="tile-value">
                {status.providers.filter((p) => p.acceptsWork).length} / {status.providers.length}
              </div>
              <div className="tile-label">Parties accepting work</div>
            </div>
            <div className={`tile ${status.agents.online === 0 && status.agents.total > 0 ? 'tile-danger' : ''}`}>
              <div className="tile-value">
                {status.agents.online} / {status.agents.total}
              </div>
              <div className="tile-label">Agents online</div>
            </div>
            <div className={`tile ${status.queue.awaitingInput > 0 ? 'tile-warn' : ''}`}>
              <div className="tile-value">
                {status.queue.queued + status.queue.running} · {status.queue.awaitingInput}
              </div>
              <div className="tile-label">Jobs in flight · awaiting input</div>
            </div>
            <div className="tile">
              <div className="tile-value">{status.relay?.openStreams ?? 0}</div>
              <div className="tile-label">Open event streams</div>
            </div>
            {report && (
              <>
                <div className={`tile ${failedToday(report) > 0 ? 'tile-warn' : ''}`} data-testid="dashboard-failures">
                  <div className="tile-value">
                    {failedToday(report)} · {peopleToday(report)}
                  </div>
                  <div className="tile-label">Failed runs today · people affected</div>
                </div>
                <div className={`tile ${reportsToRead(report) > 0 ? 'tile-warn' : ''}`} data-testid="dashboard-reports">
                  <div className="tile-value">{reportsToRead(report)}</div>
                  <div className="tile-label">Failure reports to read</div>
                </div>
              </>
            )}
          </div>

          <section className="card">
            <div className="card-head">
              <h2>Parties</h2>
              <span className="sub">
                control plane {status.service.version} · catalogue {status.service.manifestDigest.slice(0, 12)} · {status.service.kinds.join(', ')}
              </span>
            </div>
            <table data-testid="dashboard-parties">
              <thead>
                <tr>
                  <th>Party</th>
                  <th>State</th>
                  <th>Since</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {status.providers.map((p) => (
                  <tr key={p.providerId} className={p.acceptsWork ? '' : 'stale'}>
                    <td>
                      <a href={hrefOf(`providers/${encodeURIComponent(p.providerId)}`)} data-testid={`dashboard-party-${p.providerId}`}>
                        {p.providerId}
                      </a>
                    </td>
                    <td>
                      <StateChip state={p.state} testId={`dashboard-state-${p.providerId}`} />
                    </td>
                    <td>{when(p.since)}</td>
                    <td className="sub">{p.reasonKey ?? '—'}</td>
                  </tr>
                ))}
                {status.providers.length === 0 && (
                  <tr>
                    <td colSpan={4}>—</td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </>
      )}

      {health && (
        <section className="card">
          <h2>Environment</h2>
          <div className="chips" data-testid="dashboard-environment">
            <span className="chip on">build {health.build ?? '—'}</span>
            {health.protocol !== undefined && <span className="chip">protocol {health.protocol}</span>}
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

/** an environment without connectors: the relay is not configured, nothing to see yet */
export function AbsentCard() {
  return (
    <section className="card" data-testid="lab-absent">
      <p className="hint">
        This environment runs no connectors — the relay is not configured (the environment&apos;s Connectors tick in the setup wizard
        renders the control plane and the api&apos;s Connectors:* settings).
      </p>
    </section>
  );
}
